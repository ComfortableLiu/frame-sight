import type { AgentTool, ToolRuntimeDeps } from '../types.js';
import * as path from '../pathShim.js';

const BUFFER_MS = 300;
const ORIGINAL_CLIP_VOLUME = 1;

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

interface SrtCue {
  startMs: number;
  endMs: number;
}

function parseSrtCues(srt: string | undefined): SrtCue[] {
  if (!srt) return [];
  const cues: SrtCue[] = [];
  const blocks = srt.split(/\n\s*\n/);
  for (const block of blocks) {
    const timeLine = block.split('\n').find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [ts, te] = timeLine.split('-->');
    const startMs = srtTimeToMs(ts);
    const endMs = srtTimeToMs(te);
    if (startMs != null && endMs != null) cues.push({ startMs, endMs });
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

/** 校验并规范时间区间，确保 0 <= start < end */
function normalizeTimeRange(startMs: number, endMs: number, durationMs?: number): { startMs: number; endMs: number } {
  let s = Math.max(0, Math.floor(startMs));
  let e = Math.max(0, Math.floor(endMs));
  if (s >= e) {
    // 无效区间，给最小 1s 宽度
    const mid = s;
    s = Math.max(0, mid - 500);
    e = mid + 500;
  }
  if (durationMs && durationMs > 0) {
    e = Math.min(e, durationMs);
    s = Math.min(s, e - 100);
  }
  return { startMs: s, endMs: e };
}

/**
 * 时间戳对齐到最近 SRT 边界并加 300ms buffer。
 * start 向前对齐到边界（向前取最近 cue.startMs），end 向后对齐。
 */
function alignToSrtBoundaries(
  startMs: number,
  endMs: number,
  cues: SrtCue[],
  durationMs?: number,
): { startMs: number; endMs: number } {
  // 先校验区间有效性
  const norm = normalizeTimeRange(startMs, endMs, durationMs);

  if (!cues.length) {
    // 空 SRT：以传入区间为准 + buffer，限制在视频时长内
    return {
      startMs: Math.max(0, norm.startMs - BUFFER_MS),
      endMs: norm.endMs + BUFFER_MS,
    };
  }
  let alignedStart = norm.startMs;
  for (const cue of cues) {
    if (cue.startMs <= norm.startMs) alignedStart = cue.startMs;
    else break;
  }
  let alignedEnd = norm.endMs;
  for (const cue of cues) {
    if (cue.endMs >= norm.endMs) {
      alignedEnd = cue.endMs;
      break;
    }
    alignedEnd = Math.max(alignedEnd, cue.endMs);
  }
  // 加 buffer 后再次确保 start < end
  let resultStart = Math.max(0, alignedStart - BUFFER_MS);
  let resultEnd = alignedEnd + BUFFER_MS;
  if (resultStart >= resultEnd) {
    resultStart = Math.max(0, norm.startMs);
    resultEnd = norm.endMs;
  }
  return { startMs: resultStart, endMs: resultEnd };
}

/** 校验字体颜色格式（#RRGGBB 或颜色名），防止 filter 注入 */
function sanitizeFontColor(color: string): string {
  const hex = /^#[0-9A-Fa-f]{6}$/;
  const safeColors = ['white', 'black', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'gray'];
  if (hex.test(color)) return color;
  if (safeColors.includes(color.toLowerCase())) return color;
  return '#FFFFFF';
}

/** 转义 srtPath 用于 ffmpeg subtitles filter */
function escapeFilterPath(p: string): string {
  // ffmpeg filter 中路径需转义 : ' \
  return p
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

async function uploadResult(filePath: string, deps: ToolRuntimeDeps): Promise<{ objectUrl?: string; uploadError?: string }> {
  try {
    const { objectUrl } = await deps.uploadToObjectStorage(filePath);
    return { objectUrl };
  } catch (err) {
    // 上传失败不阻断，返回本地路径供 LLM 决策
    return { uploadError: err instanceof Error ? err.message : String(err) };
  }
}

export function createEditingTools(deps: ToolRuntimeDeps): AgentTool[] {
  const cues = () => parseSrtCues(deps.srtText);

  const clipAndConcat: AgentTool = {
    name: 'clip_and_concat',
    displayName: '按时间段裁剪并拼接',
    category: 'editing',
    description:
      '按指定时间段裁剪视频并拼接为单一输出，自动对齐 SRT 字幕边界并加 300ms buffer。参数: segments(数组 [{startMs,endMs}])。返回 objectUrl。',
    parameters: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { startMs: { type: 'number' }, endMs: { type: 'number' } },
            required: ['startMs', 'endMs'],
          },
        },
      },
      required: ['segments'],
    },
    handler: async (args) => {
      const segments = Array.isArray(args.segments) ? (args.segments as Array<{ startMs: number; endMs: number }>) : [];
      if (!segments.length) return JSON.stringify({ success: false, error: 'segments 为空' });
      // 校验每个 segment
      for (const s of segments) {
        if (typeof s.startMs !== 'number' || typeof s.endMs !== 'number') {
          return JSON.stringify({ success: false, error: 'segment 缺少 startMs/endMs' });
        }
      }
      const srtCues = cues();
      const durationMs = deps.durationSeconds ? deps.durationSeconds * 1000 : undefined;
      const aligned = segments.map((s) => alignToSrtBoundaries(s.startMs, s.endMs, srtCues, durationMs));
      const outputPath = path.join(deps.outputBaseDir, `clip_concat_${Date.now()}.mp4`);
      const clipPaths: string[] = [];
      for (let i = 0; i < aligned.length; i++) {
        const seg = aligned[i];
        const clipPath = path.join(deps.outputBaseDir, `seg_${i}_${Date.now()}.mp4`);
        const res = await window.viewPoint.clipSegment({
          inputPath: deps.videoPath,
          startMs: seg.startMs,
          endMs: seg.endMs,
          outputPath: clipPath,
          originalClipVolume: ORIGINAL_CLIP_VOLUME,
        });
        if (!res.success || !res.outputPath) {
          return JSON.stringify({ success: false, error: res.error ?? '裁剪失败' });
        }
        clipPaths.push(res.outputPath);
      }
      const composeRes = await window.viewPoint.composePartVideo({
        segments: clipPaths.map((p, i) => ({ clipPath: p, startMs: aligned[i].startMs, endMs: aligned[i].endMs })),
        outputPath,
      });
      if (!composeRes.success || !composeRes.outputPath) {
        return JSON.stringify({ success: false, error: composeRes.error ?? '拼接失败' });
      }
      const uploaded = await uploadResult(composeRes.outputPath, deps);
      return JSON.stringify({ success: true, objectUrl: uploaded.objectUrl, outputPath: composeRes.outputPath, uploadError: uploaded.uploadError });
    },
  };

  const removeSilence: AgentTool = {
    name: 'remove_silence',
    displayName: '去除静音',
    category: 'editing',
    description: '检测并删除静音段，自动对齐 SRT 字幕边界。参数: minDurationSec(默认 0.5), noiseTolerance(默认 -30dB)。返回 objectUrl。',
    parameters: {
      type: 'object',
      properties: {
        minDurationSec: { type: 'number', default: 0.5 },
        noiseTolerance: { type: 'number', default: -30 },
      },
    },
    handler: async (args) => {
      const minDuration = num(args, 'minDurationSec', 0.5);
      const noise = num(args, 'noiseTolerance', -30);
      const detect = await window.viewPoint.ffmpegExecute({
        args: ['-i', deps.videoPath, '-af', `silencedetect=noise=${noise}dB:d=${minDuration}`, '-f', 'null', '-'],
      });
      const silences = extractSilenceSegments(detect.stderr);
      const srtCues = cues();
      const durationSec = deps.durationSeconds ?? 0;
      // 计算保留段（非静音段）
      const keepSegments: Array<{ startMs: number; endMs: number }> = [];
      let cursor = 0;
      for (const sil of silences) {
        const startMs = sil.start * 1000;
        if (startMs > cursor) {
          keepSegments.push({ startMs: cursor, endMs: startMs });
        }
        cursor = sil.end * 1000;
      }
      if (durationSec * 1000 > cursor) {
        keepSegments.push({ startMs: cursor, endMs: durationSec * 1000 });
      }
      if (!keepSegments.length) {
        return JSON.stringify({ success: false, error: '未检测到可保留片段' });
      }
      const aligned = keepSegments.map((s) => alignToSrtBoundaries(s.startMs, s.endMs, srtCues, durationSec * 1000));
      const outputPath = path.join(deps.outputBaseDir, `no_silence_${Date.now()}.mp4`);
      const clipPaths: string[] = [];
      for (let i = 0; i < aligned.length; i++) {
        const seg = aligned[i];
        const clipPath = path.join(deps.outputBaseDir, `ns_${i}_${Date.now()}.mp4`);
        const res = await window.viewPoint.clipSegment({
          inputPath: deps.videoPath,
          startMs: seg.startMs,
          endMs: seg.endMs,
          outputPath: clipPath,
          originalClipVolume: ORIGINAL_CLIP_VOLUME,
        });
        if (!res.success || !res.outputPath) {
          return JSON.stringify({ success: false, error: res.error ?? '裁剪失败' });
        }
        clipPaths.push(res.outputPath);
      }
      const composeRes = await window.viewPoint.composePartVideo({
        segments: clipPaths.map((p, i) => ({ clipPath: p, startMs: aligned[i].startMs, endMs: aligned[i].endMs })),
        outputPath,
      });
      if (!composeRes.success || !composeRes.outputPath) {
        return JSON.stringify({ success: false, error: composeRes.error ?? '拼接失败' });
      }
      const uploaded = await uploadResult(composeRes.outputPath, deps);
      return JSON.stringify({ success: true, objectUrl: uploaded.objectUrl, outputPath: composeRes.outputPath, removedSilenceCount: silences.length, uploadError: uploaded.uploadError });
    },
  };

  const burnSubtitles: AgentTool = {
    name: 'burn_subtitles',
    displayName: '烧录字幕',
    category: 'editing',
    description: '将 SRT 字幕硬烧录到视频画面。参数: srtData(可省略用已有字幕), fontSize(默认 24), fontColor(默认 #FFFFFF)。返回 objectUrl。',
    parameters: {
      type: 'object',
      properties: {
        srtData: { type: 'string' },
        fontSize: { type: 'number', default: 24 },
        fontColor: { type: 'string', default: '#FFFFFF' },
      },
    },
    handler: async (args) => {
      const srt = typeof args.srtData === 'string' ? args.srtData : deps.srtText ?? '';
      if (!srt) return JSON.stringify({ success: false, error: '无 SRT 字幕数据' });
      const fontSize = Math.max(8, Math.min(72, Math.floor(num(args, 'fontSize', 24))));
      const fontColor = sanitizeFontColor(String(args.fontColor ?? '#FFFFFF'));
      const srtPath = path.join(deps.outputBaseDir, `subs_${Date.now()}.srt`);
      await window.viewPoint.writeTempFile({ filePath: srtPath, content: srt });
      const outputPath = path.join(deps.outputBaseDir, `burned_${Date.now()}.mp4`);
      const escapedPath = escapeFilterPath(srtPath);
      const result = await window.viewPoint.ffmpegExecute({
        args: [
          '-i', deps.videoPath,
          '-vf', `subtitles='${escapedPath}':force_style='FontSize=${fontSize},PrimaryColour=${fontColor}'`,
          '-c:a', 'copy',
          outputPath,
        ],
      });
      if (!result.success) {
        return JSON.stringify({ success: false, error: result.stderr.slice(0, 500) });
      }
      try {
        const uploaded = await uploadResult(outputPath, deps);
        return JSON.stringify({ success: true, objectUrl: uploaded.objectUrl, outputPath, uploadError: uploaded.uploadError });
      } catch (err) {
        return JSON.stringify({ success: true, outputPath, uploadError: err instanceof Error ? err.message : String(err) });
      }
    },
  };

  const exportSegment: AgentTool = {
    name: 'export_segment',
    displayName: '导出片段',
    category: 'editing',
    description: '导出视频片段为 mp4 或 GIF。参数: startMs, endMs, format(mp4|gif)。自动对齐字幕边界+300ms buffer。返回 objectUrl。',
    parameters: {
      type: 'object',
      properties: {
        startMs: { type: 'number' },
        endMs: { type: 'number' },
        format: { type: 'string', enum: ['mp4', 'gif'], default: 'mp4' },
      },
      required: ['startMs', 'endMs'],
    },
    handler: async (args) => {
      const format = args.format === 'gif' ? 'gif' : 'mp4';
      const aligned = alignToSrtBoundaries(
        num(args, 'startMs', 0), num(args, 'endMs', 0), cues(),
        deps.durationSeconds ? deps.durationSeconds * 1000 : undefined,
      );
      const ext = format === 'gif' ? 'gif' : 'mp4';
      const outputPath = path.join(deps.outputBaseDir, `export_${Date.now()}.${ext}`);
      if (format === 'gif') {
        const result = await window.viewPoint.ffmpegExecute({
          args: [
            '-i', deps.videoPath,
            '-ss', (aligned.startMs / 1000).toString(),
            '-to', (aligned.endMs / 1000).toString(),
            '-vf', 'fps=10,scale=480:-1:flags=lanczos',
            '-loop', '0',
            outputPath,
          ],
        });
        if (!result.success) return JSON.stringify({ success: false, error: result.stderr.slice(0, 500) });
      } else {
        const res = await window.viewPoint.clipSegment({
          inputPath: deps.videoPath,
          startMs: aligned.startMs,
          endMs: aligned.endMs,
          outputPath,
          originalClipVolume: ORIGINAL_CLIP_VOLUME,
        });
        if (!res.success) return JSON.stringify({ success: false, error: res.error ?? '导出失败' });
      }
      const uploaded = await uploadResult(outputPath, deps);
      return JSON.stringify({ success: true, objectUrl: uploaded.objectUrl, outputPath, format, uploadError: uploaded.uploadError });
    },
  };

  return [clipAndConcat, removeSilence, burnSubtitles, exportSegment];
}

function extractSilenceSegments(stderr: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  const startRe = /silence_start:\s*(-?\d+\.?\d*)/g;
  while ((m = startRe.exec(stderr)) !== null) starts.push(Math.max(0, parseFloat(m[1])));
  const endRe = /silence_end:\s*(-?\d+\.?\d*)/g;
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]));
  const segments: Array<{ start: number; end: number }> = [];
  for (let i =  0; i < starts.length; i++) {
    const start = starts[i];
    const end = ends[i] ?? start;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}
