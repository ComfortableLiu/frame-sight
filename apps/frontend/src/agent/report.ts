import type { LlmCaller, LlmMessage, LlmContentPart, LlmEndpoint } from './types.js';
import { parseSrtCues, srtTimeToMs } from './tools/shared.js';
import { transcribeViaRecognitionConfig } from './asr.js';

const MAX_RETRIES = 2;
/** 最大分析段数，防止超长视频产生过多 LLM 调用 */
const MAX_SEGMENTS = 30;
/** 单段视频目标大小上限（视频模型 URL 传入限制 300MB，留余量） */
const SEGMENT_TARGET_BYTES = 280 * 1024 * 1024;
/** 360P 去音轨转码后的估算码率（约 2Mbps），用于推算单段时长 */
const EST_SEGMENT_BYTES_PER_SEC = 0.25 * 1024 * 1024;
/** 单段最短时长（秒），避免段过短 */
const MIN_SEGMENT_SECONDS = 120;

/**
 * 计算分段时长：在保证单个分段视频文件 < 300M 的前提下尽量长
 * （按 360P 转码后的估算码率推算），不短于 MIN_SEGMENT_SECONDS。
 */
function computeSegmentSeconds(totalDuration: number): number {
  const bySize = Math.floor(SEGMENT_TARGET_BYTES / EST_SEGMENT_BYTES_PER_SEC); // ≈1120s
  if (totalDuration <= 0) return bySize;
  return Math.max(MIN_SEGMENT_SECONDS, Math.min(bySize, Math.ceil(totalDuration)));
}

/** 读取本地 SRT 缓存（按文件路径+大小），未命中返回 null。 */
async function readCachedSrt(videoPath: string): Promise<string | null> {
  try {
    const size = (await window.viewPoint.statFile(videoPath))?.size ?? 0;
    const cached = await window.viewPoint.getSrtCache({ filePath: videoPath, size });
    if (cached?.hit && cached.srt) return cached.srt;
  } catch { /* 缓存读取失败不影响正常流程 */ }
  return null;
}

/** 写入本地 SRT 缓存。 */
async function writeCachedSrt(videoPath: string, srt: string): Promise<void> {
  try {
    const size = (await window.viewPoint.statFile(videoPath))?.size ?? 0;
    await window.viewPoint.saveSrtCache({ filePath: videoPath, size, srt });
  } catch { /* 缓存写入失败忽略 */ }
}

/** 调用 LLM 全模态生成 SRT 字幕（带重试，带本地缓存）。 */
export async function generateSrtWithRetry(
  caller: LlmCaller,
  endpoint: LlmEndpoint,
  videoPath: string,
  signal?: AbortSignal,
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>,
): Promise<string> {
  const cached = await readCachedSrt(videoPath);
  if (cached) return cached;
  const srt = await generateSrtWithRetryUncached(caller, endpoint, videoPath, signal, uploadToObjectStorage);
  await writeCachedSrt(videoPath, srt);
  return srt;
}

async function generateSrtWithRetryUncached(
  caller: LlmCaller,
  endpoint: LlmEndpoint,
  videoPath: string,
  signal?: AbortSignal,
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const srt = await generateSrtOnce(caller, endpoint, videoPath, signal, uploadToObjectStorage);
      if (srt && srt.trim()) return srt;
      throw new Error('SRT 为空');
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error('SRT 生成失败');
}

async function generateSrtOnce(
  caller: LlmCaller,
  endpoint: LlmEndpoint,
  videoPath: string,
  signal?: AbortSignal,
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>,
): Promise<string> {
  // 优先使用"设置 → 语音设置"中启用的语音识别(ASR)服务（如 MiMo ASR）
  const asrSrt = await transcribeViaRecognitionConfig(videoPath, signal);
  if (asrSrt) return asrSrt;

  // 通过 ffmpeg 提取音频
  const audio = await window.viewPoint.extractAudioFromVideo(videoPath);
  if (!audio.success || !audio.outputPath) {
    throw new Error('音频提取失败');
  }
  const audioPath = audio.outputPath;

  try {
    // 策略 1：调用标准 /audio/transcriptions 端点（OpenAI Whisper 兼容）
    try {
      const srt = await callTranscriptionEndpoint(endpoint, audioPath, signal);
      if (srt && srt.trim()) return srt;
    } catch (err) {
      console.warn('/audio/transcriptions 失败，回退到多模态 chat:', err);
    }

    // 策略 2：回退到多模态 chat
    // 先上传音频到 S3，用可访问 URL 替代本地路径
    let audioRef = audioPath;
    if (uploadToObjectStorage) {
      try {
        const uploaded = await uploadToObjectStorage(audioPath);
        if (uploaded.objectUrl) audioRef = uploaded.objectUrl;
      } catch (err) {
        console.warn('音频上传 S3 失败，使用本地路径:', err);
      }
    }

  const isUrl = audioRef.startsWith('http');
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: '你是语音转写助手。请根据提供的音频生成标准 SRT 字幕格式（含序号、时间戳、文字）。仅输出 SRT 文本，不要解释。',
    },
    {
      role: 'user',
      content: isUrl
        ? `请转写以下音频为 SRT 字幕。音频 URL: ${audioRef}\n\n如果无法访问音频，请回复 "TRANSCRIBE_FAILED"。`
        : `请转写以下音频为 SRT 字幕。音频文件路径: ${audioRef}\n\n如果无法访问音频，请回复 "TRANSCRIBE_FAILED"。`,
    },
  ];
    const result = await caller(messages, { signal });
    if (!result || result.trim() === 'TRANSCRIBE_FAILED' || !result.trim()) {
      throw new Error('语音转写失败：/audio/transcriptions 不可用，模型也无法转写。请确认 API 支持语音转写端点，或配置支持音频输入的多模态模型。');
    }
    return result;
  } finally {
    // 提取的音频为临时文件，用完删除
    window.viewPoint.deleteFile({ filePath: audioPath }).catch(() => {});
  }
}

/**
 * 调用标准 /audio/transcriptions 端点（OpenAI Whisper 兼容）。
 * 支持 OpenAI、阿里百炼、火山引擎等主流平台。
 */
async function callTranscriptionEndpoint(
  endpoint: LlmEndpoint,
  audioPath: string,
  signal?: AbortSignal,
): Promise<string> {
  // 读取音频文件
  const fileResult = await window.viewPoint.readFileAsBase64(audioPath);
  if (!fileResult.success || !fileResult.base64) {
    throw new Error('读取音频文件失败');
  }

  // base64 → Blob
  const binaryStr = atob(fileResult.base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const ext = audioPath.split('.').pop() ?? 'mp3';
  const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
  const blob = new Blob([bytes], { type: mimeType });

  const url = joinUrl(endpoint.apiBase, '/audio/transcriptions');

  // 尝试 SRT 格式，失败则回退纯文本
  for (const format of ['srt', 'text'] as const) {
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', endpoint.modelName);
    if (format === 'srt') form.append('response_format', 'srt');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      body: form,
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // 404/405 说明该 API 不支持 transcriptions，直接抛出让上层回退
      if (res.status === 404 || res.status === 405) {
        throw new Error(`API 不支持 /audio/transcriptions (${res.status})`);
      }
      throw new Error(`转写请求失败 ${res.status}: ${errText.slice(0, 200)}`);
    }

    const text = await res.text();
    if (format === 'srt' && text.includes('-->')) {
      return text; // 已是 SRT 格式
    }
    if (format === 'text' && text.trim()) {
      // 纯文本转写 → 生成近似 SRT（无精确时间戳）
      return plainTextToApproxSrt(text.trim());
    }
  }

  throw new Error('转写结果为空');
}

/** 纯文本转近似 SRT（按句子分割，均匀分配时间戳）。 */
function plainTextToApproxSrt(text: string): string {
  const sentences = text.split(/(?<=[。！？.!?\n])\s*/).filter(Boolean);
  if (!sentences.length) return text;
  const avgDuration = 5; // 每句约 5 秒
  const lines: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const start = i * avgDuration;
    const end = start + avgDuration;
    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(start)} --> ${formatSrtTime(end)}`);
    lines.push(sentences[i]);
    lines.push('');
  }
  return lines.join('\n');
}

function formatSrtTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},000`;
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}

export type ReportPhase = '分离音频' | '音频拆分' | '语音识别' | '字幕合成' | '视频拆分' | '视频分析' | '合并报告';

export interface ReportProgress {
  phase: ReportPhase;
  current: number;
  total: number;
  detail?: string;
}

/**
 * 结构化报告生成：SRT 转写 → 按相同时间边界拆分视频（360P、去音轨）→
 * 视频分段上传用户配置的对象存储（S3），每段以【视频 URL + 对应时段 SRT 文本】
 * 交给支持视频的模型分析 → 合并为结构化报告。
 * 单段视频切割/上传/分析失败时回退该段纯 SRT 文本分析（原因写入报告末尾，不静默）；
 * 分段失败与合并失败均有兜底。
 */
export async function generateStructuredReport(args: {
  textCaller: LlmCaller;
  textEndpoint: LlmEndpoint;
  videoCaller: LlmCaller;
  videoPath: string;
  durationSeconds: number | null;
  signal?: AbortSignal;
  onProgress?: (p: ReportProgress) => void;
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>;
}): Promise<{ srt: string; report: string }> {
  const { textCaller, videoCaller, videoPath, durationSeconds, signal, onProgress } = args;

  // ── SRT 转写阶段：分离音频 → 音频拆分 → 语音识别 → 字幕合成 ──
  const srt = await transcribeSrtStage(args);

  // durationSeconds 可能因调用方时序问题为 null，此处兜底探测，否则无法切分视频段
  const total = durationSeconds ?? (await window.viewPoint.getMediaDuration(videoPath)) ?? 0;
  const segmentSeconds = computeSegmentSeconds(total);
  let segments = splitSrtByTime(srt, total, segmentSeconds);
  // 段数上限：超出则按段数均匀扩大段长（完整覆盖时间线，不丢段）
  if (segments.length > MAX_SEGMENTS) {
    segments = splitSrtByTime(srt, total, Math.ceil(total / MAX_SEGMENTS));
  }
  const errors: string[] = [];
  /** 视频画面分析被回退的原因（去重），最终写入报告，避免静默回退 */
  const videoFallbacks = new Set<string>();

  // ── 第一阶段：全部切分（360P、无音轨）并上传 S3 ──
  const segVideos: Array<{ url: string | null; error?: string }> = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    onProgress?.({
      phase: '视频拆分',
      current: i + 1,
      total: segments.length,
      detail: `${formatTime(seg.startSec)}-${formatTime(seg.endSec)}`,
    });
    const segVideo = await tryGetSegmentVideoUrl(videoPath, seg, i, args.uploadToObjectStorage);
    if (!segVideo.url && segVideo.error) videoFallbacks.add(segVideo.error);
    segVideos.push(segVideo);
  }

  // ── 第二阶段：并发 4 路分析（结果按下标回填，保持段顺序） ──
  const analyses: string[] = new Array(segments.length);
  const CONCURRENCY = Math.min(4, segments.length);
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (nextIndex < segments.length) {
      if (signal?.aborted) break;
      const i = nextIndex++;
      const seg = segments[i];
      const detail = `${formatTime(seg.startSec)}-${formatTime(seg.endSec)}`;
      try {
        analyses[i] = await analyzeOneSegment(
          textCaller, videoCaller, seg, i, segments.length, segVideos[i].url,
          (reason) => videoFallbacks.add(reason), signal,
        );
      } catch (err) {
        // 单段失败不阻断整体
        errors.push(`段 ${i + 1} 分析失败: ${err instanceof Error ? err.message : String(err)}`);
        analyses[i] = `[段落 ${i + 1}（${detail}）分析失败]`;
      }
      completed += 1;
      onProgress?.({ phase: '视频分析', current: completed, total: segments.length, detail });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (videoFallbacks.size) {
    errors.push(
      `部分分段未使用视频画面分析（已回退纯文本分析），原因：${[...videoFallbacks].join('；')}`,
    );
  }

  onProgress?.({ phase: '合并报告', current: 0, total: 0 });
  let report: string;
  const joinedAnalyses = analyses.join('\n\n');
  try {
    report = await mergeReport(textCaller, analyses, signal);
    // 合并结果被截断/流中断导致过短时，附全部分段详录保底，避免内容缺失
    if (report.length < joinedAnalyses.length * 0.5) {
      console.warn(`[report] 合并结果(${report.length}字)远小于分段总量(${joinedAnalyses.length}字)，附分段详录`);
      report += `\n\n---\n\n## 分段详录（合并结果不完整，附全部分段分析）\n\n${joinedAnalyses}`;
    }
  } catch (err) {
    // 合并失败：用各段分析拼接
    report = `# 拉片报告（合并失败，仅分段）\n\n${joinedAnalyses}\n\n[合并错误: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (errors.length) {
    report += `\n\n## 分析过程中的问题\n${errors.map((e) => `- ${e}`).join('\n')}`;
  }
  return { srt, report };
}

/**
 * SRT 转写阶段：优先命中本地 SRT 缓存；未命中时走实际转写（ASR 服务优先，
 * 未配置回退 generateSrtWithRetry），成功后写入缓存。
 */
async function transcribeSrtStage(args: {
  textCaller: LlmCaller;
  textEndpoint: LlmEndpoint;
  videoPath: string;
  signal?: AbortSignal;
  onProgress?: (p: ReportProgress) => void;
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>;
}): Promise<string> {
  const cached = await readCachedSrt(args.videoPath);
  if (cached) {
    args.onProgress?.({ phase: '字幕合成', current: 0, total: 0, detail: '命中缓存' });
    return cached;
  }
  const srt = await transcribeSrtStageUncached(args);
  await writeCachedSrt(args.videoPath, srt);
  return srt;
}

/**
 * SRT 实际转写：优先走设置中启用的 ASR 服务（细粒度进度，失败按现有策略重试）；
 * 未配置 ASR 时回退 generateSrtWithRetry（Whisper 端点/多模态），上报粗粒度进度。
 */
async function transcribeSrtStageUncached(args: {
  textCaller: LlmCaller;
  textEndpoint: LlmEndpoint;
  videoPath: string;
  signal?: AbortSignal;
  onProgress?: (p: ReportProgress) => void;
  uploadToObjectStorage?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>;
}): Promise<string> {
  const { textCaller, textEndpoint, videoPath, signal, onProgress, uploadToObjectStorage } = args;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const asrSrt = await transcribeViaRecognitionConfig(videoPath, signal, onProgress);
      if (asrSrt) return asrSrt;
      lastErr = null;
      break; // 未配置 ASR：走通用转写
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (lastErr) throw lastErr;

  onProgress?.({ phase: '分离音频', current: 0, total: 0 });
  const pending = generateSrtWithRetry(textCaller, textEndpoint, videoPath, signal, uploadToObjectStorage);
  onProgress?.({ phase: '语音识别', current: 0, total: 0 });
  return pending;
}

/** 切割单段视频（360P、无音轨）并上传对象存储，返回可访问 URL；失败返回原因，由调用方回退纯文本分析。 */
async function tryGetSegmentVideoUrl(
  videoPath: string,
  seg: SrtSegment,
  index: number,
  upload?: (filePath: string) => Promise<{ objectUrl: string; error?: string }>,
): Promise<{ url: string | null; error?: string }> {
  if (seg.endSec <= seg.startSec) return { url: null, error: '视频时长未知，无法确定切割区间' };
  if (!upload) return { url: null, error: '未配置对象存储（S3），无法上传视频分段' };
  try {
    const segPath = await cutVideoSegment(videoPath, seg.startSec, seg.endSec, index);
    try {
      const res = await upload(segPath);
      if (!res.objectUrl) throw new Error(res.error || '上传未返回访问 URL');
      console.info(`[report] 段 ${index + 1} 视频分段已上传: ${res.objectUrl}`);
      return { url: res.objectUrl };
    } finally {
      // 视频分段为临时文件，上传后删除
      window.viewPoint.deleteFile({ filePath: segPath }).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`段 ${index + 1} 视频切割/上传失败，回退纯文本分析:`, msg);
    return { url: null, error: `视频切割/上传失败: ${msg.slice(0, 120)}` };
  }
}

/** 用 ffmpeg 按时间边界切割视频段：转码 360P、移除音轨，输出到源视频同目录。 */
async function cutVideoSegment(videoPath: string, startSec: number, endSec: number, index: number): Promise<string> {
  const dir = videoPath.slice(0, Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\')));
  const outPath = `${dir}/segment_${index + 1}_${Date.now()}.mp4`;
  const res = await window.viewPoint.ffmpegExecute({
    args: [
      '-ss', startSec.toFixed(2), '-to', endSec.toFixed(2), '-i', videoPath,
      '-vf', 'scale=-2:360', '-an', '-c:v', 'libx264', '-preset', 'fast', outPath,
    ],
  });
  if (!res.success) throw new Error(`视频切分失败: ${res.stderr.slice(0, 200)}`);
  return outPath;
}

/** 单段分析：优先【视频片段 URL + 对应时段 SRT 文本】交给视频模型；失败回退纯 SRT 文本分析。 */
async function analyzeOneSegment(
  textCaller: LlmCaller,
  videoCaller: LlmCaller,
  seg: SrtSegment,
  index: number,
  total: number,
  videoUrl: string | null,
  onVideoFallback: (reason: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!videoUrl) {
    return analyzeSegment(textCaller, index, total, seg.startSec, seg.endSec, seg.text, signal);
  }
  try {
    return await analyzeSegmentWithVideo(videoCaller, index, total, seg.startSec, seg.endSec, seg.text, videoUrl, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`段 ${index + 1} 视频分析失败，回退纯文本分析:`, msg);
    onVideoFallback(`视频模型分析失败: ${msg.slice(0, 120)}`);
    return analyzeSegment(textCaller, index, total, seg.startSec, seg.endSec, seg.text, signal);
  }
}

/** 视频模型单段分析：content 为 [视频分段 URL, 时段范围 + 该段 SRT 字幕 + 分析要求]。 */
async function analyzeSegmentWithVideo(
  caller: LlmCaller,
  index: number,
  total: number,
  startSec: number,
  endSec: number,
  text: string,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: LlmMessage<string | LlmContentPart[]>[] = [
    {
      role: 'system',
      content:
        '你是视频拉片分析师。结合视频画面与对应时段字幕，输出该段的结构化分析：内容主题、关键事件（带时间戳）、重要对话、画面与镜头要点。Markdown 格式。',
    },
    {
      role: 'user',
      content: [
        { type: 'video_url', video_url: { url: videoUrl }, fps: 2, media_resolution: 'default' },
        {
          type: 'text',
          text: `段落 ${index + 1}/${total}（${formatTime(startSec)} - ${formatTime(endSec)}）字幕：\n${text || '（无字幕）'}\n\n请结合该时段的视频画面完成分析。`,
        },
      ],
    },
  ];
  console.info(`[report] 段 ${index + 1}/${total} 请求视频模型分析: ${videoUrl.slice(0, 80)}`);
  // caller.ts 会把 messages 原样 JSON 序列化 POST（已确认无拦截），此处收窄回纯文本消息类型
  return caller(messages as LlmMessage[], { signal });
}

interface SrtSegment {
  startSec: number;
  endSec: number;
  text: string;
}

function splitSrtByTime(srt: string, totalDuration: number, segmentSeconds: number): SrtSegment[] {
  const cues = parseSrtCues(srt);
  if (!cues.length || totalDuration <= 0) {
    return [{ startSec: 0, endSec: totalDuration || 0, text: srt }];
  }
  const segments: SrtSegment[] = [];
  const segCount = Math.max(1, Math.ceil(totalDuration / segmentSeconds));
  for (let i = 0; i < segCount; i++) {
    const startSec = i * segmentSeconds;
    const endSec = Math.min(totalDuration, (i + 1) * segmentSeconds);
    const text = cues
      .filter((c) => c.startMs >= startSec * 1000 && c.startMs < endSec * 1000)
      .map((c) => c.text)
      .join(' ');
    segments.push({ startSec, endSec, text });
  }
  return segments;
}




async function analyzeSegment(
  caller: LlmCaller,
  index: number,
  total: number,
  startSec: number,
  endSec: number,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        '你是视频拉片分析师。根据给定时间段的字幕，输出该段的结构化分析：内容主题、关键事件（带时间戳）、重要对话。Markdown 格式。',
    },
    {
      role: 'user',
      content: `段落 ${index + 1}/${total}（${formatTime(startSec)} - ${formatTime(endSec)}）字幕：\n${text || '（无字幕）'}`,
    },
  ];
  return caller(messages, { signal });
}

async function mergeReport(caller: LlmCaller, analyses: string[], signal?: AbortSignal): Promise<string> {
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        '你是视频拉片报告编辑。将各段分析合并为一份完整的结构化拉片报告，按时间线组织，含：整体概览、分段要点、关键时间戳索引。Markdown 格式。',
    },
    {
      role: 'user',
      content: analyses.map((a, i) => `## 段落 ${i + 1}\n${a}`).join('\n\n'),
    },
  ];
  return caller(messages, { signal });
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
