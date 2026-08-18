/**
 * 工具模块共享的 ffmpeg 解析与参数工具函数。
 */

/** 从 ffmpeg silencedetect stderr 提取静音段。 */
export function extractSilenceSegments(stderr: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  const startRe = /silence_start:\s*(-?\d+\.?\d*)/g;
  while ((m = startRe.exec(stderr)) !== null) starts.push(Math.max(0, parseFloat(m[1])));
  const endRe = /silence_end:\s*(-?\d+\.?\d*)/g;
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]));
  const segments: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = ends[i] ?? start;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}

/** 从 ffmpeg scene detect stderr 提取场景切换时间戳。 */
export function extractSceneTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const re = /pts_time:(\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    timestamps.push(parseFloat(m[1]));
  }
  return timestamps;
}

/** 安全取数值参数，非有限数回退默认值。 */
export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 限制数值在 [min, max] 范围。 */
export function clampNum(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num(args, key, fallback)));
}

// ── SRT 解析 ──

export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** SRT 时间字符串 → 毫秒。 */
export function srtTimeToMs(s: string): number | null {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return (
    parseInt(m[1]) * 3600000 +
    parseInt(m[2]) * 60000 +
    parseInt(m[3]) * 1000 +
    parseInt(m[4].padEnd(3, '0').slice(0, 3))
  );
}

/** 解析 SRT 文本为 cue 数组。 */
export function parseSrtCues(srt: string | undefined): SrtCue[] {
  if (!srt) return [];
  const cues: SrtCue[] = [];
  const blocks = srt.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const [ts, te] = lines[timeLineIdx].split('-->');
    const startMs = srtTimeToMs(ts);
    const endMs = srtTimeToMs(te);
    if (startMs == null || endMs == null) continue;
    cues.push({
      startMs,
      endMs,
      text: lines.slice(timeLineIdx + 1).join(' '),
    });
  }
  return cues;
}
