import type { LlmCaller, LlmMessage, LlmEndpoint } from './types.js';

const SEGMENT_SECONDS = 60;
const MAX_RETRIES = 2;

/** 调用 LLM 全模态生成 SRT 字幕（带重试）。 */
export async function generateSrtWithRetry(
  caller: LlmCaller,
  endpoint: LlmEndpoint,
  videoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const srt = await generateSrtOnce(caller, videoPath, signal);
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
  videoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  // 通过 ffmpeg 提取音频
  const audio = await window.viewPoint.extractAudioFromVideo(videoPath);
  if (!audio.success || !audio.outputPath) {
    throw new Error('音频提取失败');
  }

  // 注意：标准 OpenAI chat completions 文本接口无法直接接收音频文件。
  // 真正的语音转写需调用 /audio/transcriptions（whisper）端点或支持音频输入的多模态模型。
  // 当前 caller 走 chat completions，此处把音频路径作为上下文提供给 LLM，
  // 由支持多模态的模型（如 qwen-audio）解析；若模型不支持，将返回空/无效内容，
  // 由 generateSrtWithRetry 重试，最终由上层报告失败提示用户配置支持 ASR 的模型。
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: '你是语音转写助手。请根据提供的音频生成标准 SRT 字幕格式（含序号、时间戳、文字）。仅输出 SRT 文本，不要解释。',
    },
    {
      role: 'user',
      content: `请转写以下音频为 SRT 字幕。音频文件路径: ${audio.outputPath}\n\n如果无法访问音频，请回复 "TRANSCRIBE_FAILED"。`,
    },
  ];
  const result = await caller(messages, { signal, maxTokens: 6000 });
  if (!result || result.trim() === 'TRANSCRIBE_FAILED' || !result.trim()) {
    throw new Error('模型无法转写音频，请确认已配置支持语音转写的模型');
  }
  return result;
}

export interface ReportProgress {
  phase: string;
  current: number;
  total: number;
}

/**
 * 结构化报告生成：SRT 识别 → 分段分析 → 合并报告。
 * onProgress 回调报告当前阶段进度。
 * 分段分析失败时容错，返回已生成的部分。
 */
export async function generateStructuredReport(
  caller: LlmCaller,
  endpoint: LlmEndpoint,
  videoPath: string,
  durationSeconds: number | null,
  signal?: AbortSignal,
  onProgress?: (progress: ReportProgress) => void,
): Promise<{ srt: string; report: string }> {
  onProgress?.({ phase: '提取音频 & SRT 转写', current: 0, total: 0 });
  const srt = await generateSrtWithRetry(caller, endpoint, videoPath, signal);

  const total = durationSeconds ?? 0;
  let segments = splitSrtByTime(srt, total, SEGMENT_SECONDS);
  // 限制最大段数，防止超长视频产生过多 LLM 调用
  const MAX_SEGMENTS = 30;
  if (segments.length > MAX_SEGMENTS) {
    const step = Math.ceil(segments.length / MAX_SEGMENTS);
    segments = segments.filter((_, i) => i % step === 0).slice(0, MAX_SEGMENTS);
  }
  const analyses: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    onProgress?.({ phase: '分段分析', current: i + 1, total: segments.length });
    const seg = segments[i];
    try {
      const analysis = await analyzeSegment(
        caller, i, segments.length, seg.startSec, seg.endSec, seg.text, signal,
      );
      analyses.push(analysis);
    } catch (err) {
      // 单段失败不阻断整体
      errors.push(`段 ${i + 1} 分析失败: ${err instanceof Error ? err.message : String(err)}`);
      analyses.push(`[段落 ${i + 1}（${formatTime(seg.startSec)}-${formatTime(seg.endSec)}）分析失败]`);
    }
  }

  onProgress?.({ phase: '合并报告', current: 0, total: 0 });
  let report: string;
  try {
    report = await mergeReport(caller, analyses, signal);
  } catch (err) {
    // 合并失败：用各段分析拼接
    report = `# 拉片报告（合并失败，仅分段）\n\n${analyses.join('\n\n')}\n\n[合并错误: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (errors.length) {
    report += `\n\n## 分析过程中的问题\n${errors.map((e) => `- ${e}`).join('\n')}`;
  }
  return { srt, report };
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

interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

function parseSrtCues(srt: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = srt.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const [ts, te] = lines[timeLineIdx].split('-->');
    cues.push({
      startMs: srtTimeToMs(ts) ?? 0,
      endMs: srtTimeToMs(te) ?? 0,
      text: lines.slice(timeLineIdx + 1).join(' '),
    });
  }
  return cues;
}

function srtTimeToMs(s: string): number | null {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return (
    parseInt(m[1]) * 3600000 +
    parseInt(m[2]) * 60000 +
    parseInt(m[3]) * 1000 +
    parseInt(m[4].padEnd(3, '0').slice(0, 3))
  );
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
  return caller(messages, { signal, maxTokens: 1500 });
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
  return caller(messages, { signal, maxTokens: 4000 });
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
