/**
 * 语音识别（ASR）服务调用。
 * 使用"设置 → 语音设置"中启用的识别配置转写视频音频为 SRT。
 *
 * 接口形式（参考小米 MiMo）：
 * POST {apiBase}/chat/completions，header 携带 api-key，
 * body 中 messages[].content[] 使用 input_audio 内联 base64 音频，
 * asr_options.language 指定识别语言。
 * base64 超过 10M 时按音频时长均匀切分（每段尾部保留缓冲时间）逐段识别后拼接。
 */

/** 单次识别请求的 base64 大小上限（10M），超过则均匀切分音频。 */
const MAX_AUDIO_BASE64_CHARS = 10 * 1024 * 1024;
/** 切分时每段尾部保留的缓冲时长（秒），避免截断边界语句。 */
const CHUNK_OVERLAP_SEC = 5;

interface AsrConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  language: string;
}

/**
 * ASR 转写进度。阶段名与 report.ts 的 ReportPhase 结构兼容，
 * 由 report.ts 的 onProgress 直接透传。
 */
export interface AsrProgress {
  phase: '分离音频' | '音频拆分' | '语音识别' | '字幕合成';
  current: number;
  total: number;
  detail?: string;
}

/**
 * 使用设置中启用的语音识别(ASR)服务转写音频为 SRT。
 * 未启用/未配置/音频提取失败时返回 null，由调用方回退到其他转写方式；
 * 已配置但请求失败时直接抛错（不做静默回退，保证错误可见）。
 * onProgress 上报阶段进度：分离音频 → 音频拆分 i/N → 语音识别 i/N → 字幕合成。
 */
export async function transcribeViaRecognitionConfig(
  videoPath: string,
  signal?: AbortSignal,
  onProgress?: (p: AsrProgress) => void,
): Promise<string | null> {
  let snap: { recognition?: { enabled: boolean } & AsrConfig };
  try {
    snap = await window.viewPoint.getVoiceConfig();
  } catch {
    return null;
  }
  const r = snap?.recognition;
  if (!r?.enabled || !r.apiBase || !r.apiKey || !r.model) return null;

  onProgress?.({ phase: '分离音频', current: 0, total: 0 });
  const audio = await window.viewPoint.extractAudioFromVideo(videoPath);
  if (!audio.success || !audio.outputPath) {
    return null;
  }
  const audioPath = audio.outputPath;
  /** 本流程产生的临时文件（提取的音频 + 切分分段），用完自动删除 */
  const tempFiles: string[] = [audioPath];

  try {
    const fileResult = await window.viewPoint.readFileAsBase64(audioPath);
    if (!fileResult.success || !fileResult.base64) return null;

    const duration = await window.viewPoint.getMediaDuration(audioPath);

    // 未超限：单段直接识别
    if (fileResult.base64.length <= MAX_AUDIO_BASE64_CHARS) {
      onProgress?.({ phase: '语音识别', current: 1, total: 1 });
      const text = await requestAsr(r, fileResult.base64, 'audio/mpeg', signal);
      onProgress?.({ phase: '字幕合成', current: 0, total: 0 });
      return toApproxSrt([{ startSec: 0, endSec: duration ?? 0, text }]);
    }

    // 超限：按时长均匀切分，每段尾部保留缓冲时间
    if (!duration || duration <= 0) {
      throw new Error('音频 base64 超过 10M，且无法获取音频时长进行切分');
    }
    // 10% 余量，防止重编码后单段仍超限
    const chunkCount = Math.ceil(fileResult.base64.length / (MAX_AUDIO_BASE64_CHARS * 0.9));
    const chunkDur = duration / chunkCount;
    const stem = audioPath.replace(/\.[^.]+$/, '');

    // 先切分出全部分段（时间戳按名义区间标注，不含缓冲段）
    const cutChunks: Array<{ path: string; startSec: number; endSec: number }> = [];
    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * chunkDur;
      const nominalEnd = Math.min(duration, (i + 1) * chunkDur);
      // 最后一段已到结尾，无需缓冲
      const endSec = nominalEnd >= duration ? duration : Math.min(duration, nominalEnd + CHUNK_OVERLAP_SEC);
      const chunkPath = `${stem}_chunk${i + 1}_${Date.now()}.mp3`;

      onProgress?.({ phase: '音频拆分', current: i + 1, total: chunkCount });
      const cut = await window.viewPoint.ffmpegExecute({
        args: ['-ss', startSec.toFixed(2), '-to', endSec.toFixed(2), '-i', audioPath, '-vn', '-acodec', 'libmp3lame', chunkPath],
      });
      if (!cut.success) {
        throw new Error(`音频切分失败（第 ${i + 1}/${chunkCount} 段）: ${cut.stderr.slice(0, 200)}`);
      }
      tempFiles.push(chunkPath);
      cutChunks.push({ path: chunkPath, startSec, endSec: nominalEnd });
    }

    // 再逐段识别
    const chunks: Array<{ startSec: number; endSec: number; text: string }> = [];
    for (let i = 0; i < cutChunks.length; i++) {
      const c = cutChunks[i];
      onProgress?.({ phase: '语音识别', current: i + 1, total: cutChunks.length });
      const chunkFile = await window.viewPoint.readFileAsBase64(c.path);
      if (!chunkFile.success || !chunkFile.base64) {
        throw new Error(`读取音频分段失败（第 ${i + 1}/${cutChunks.length} 段）`);
      }
      const text = await requestAsr(r, chunkFile.base64, 'audio/mpeg', signal);
      chunks.push({ startSec: c.startSec, endSec: c.endSec, text });
    }
    onProgress?.({ phase: '字幕合成', current: 0, total: 0 });
    return toApproxSrt(chunks);
  } finally {
    for (const f of tempFiles) {
      window.viewPoint.deleteFile({ filePath: f }).catch(() => {});
    }
  }
}

/** 调用 chat/completions 风格的 ASR 接口（流式），返回识别文本。 */
async function requestAsr(
  cfg: AsrConfig,
  base64: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = joinUrl(cfg.apiBase, '/chat/completions');
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    asr_options: { language: cfg.language || 'auto' },
    stream: true,
  };

  // apiKey 原样放入 api-key 头（明文，不做任何加工）
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`语音识别失败 ${res.status}: ${errText.slice(0, 200)}`);
  }

  // 流式（SSE）响应：逐行解析 data: 事件，累积 delta.content
  const contentType = res.headers.get('content-type') ?? '';
  const text = contentType.includes('text/event-stream')
    ? await readSseText(res, signal)
    : extractMessageText(await res.json());
  if (!text.trim()) throw new Error('语音识别返回为空');
  return text.trim();
}

/** 读取 SSE 流，拼接所有 choices[0].delta.content 片段。 */
async function readSseText(res: Response, signal?: AbortSignal): Promise<string> {
  if (!res.body) throw new Error('语音识别响应无内容');
  const reader = res.body.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          text += extractMessageText(JSON.parse(data), true);
        } catch {
          // 忽略不完整/非 JSON 行
        }
      }
    }
    // 处理末尾残余
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          text += extractMessageText(JSON.parse(data), true);
        } catch { /* ignore */ }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return text;
}

/** 从 chat completion（流式 delta 或完整 message）中提取文本。 */
function extractMessageText(json: unknown, delta = false): string {
  const choice = (json as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> })
    ?.choices?.[0];
  const content = (delta ? choice?.delta?.content : choice?.message?.content) ?? choice?.message?.content ?? choice?.delta?.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p as { text?: string })?.text ?? '').join('')
      : '';
}

/** 将各段识别文本按时间区间生成近似 SRT（段内按句子均匀分配时间戳）。 */
function toApproxSrt(chunks: Array<{ startSec: number; endSec: number; text: string }>): string {
  // 若接口本身返回了带时间戳的内容，直接拼接
  if (chunks.some((c) => c.text.includes('-->'))) {
    return chunks.map((c) => c.text).join('\n\n');
  }
  const lines: string[] = [];
  let index = 0;
  for (const chunk of chunks) {
    const sentences = chunk.text.split(/(?<=[。！？.!?\n])\s*/).filter(Boolean);
    if (!sentences.length) continue;
    const span = Math.max(chunk.endSec - chunk.startSec, 1);
    const step = span / sentences.length;
    for (const s of sentences) {
      index += 1;
      lines.push(String(index));
      lines.push(`${formatSrtTime(chunk.startSec)} --> ${formatSrtTime(Math.min(chunk.startSec + step, chunk.endSec))}`);
      lines.push(s);
      lines.push('');
      chunk.startSec += step;
    }
  }
  return lines.join('\n');
}

function formatSrtTime(totalSec: number): string {
  const sec = Math.max(0, totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},000`;
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}
