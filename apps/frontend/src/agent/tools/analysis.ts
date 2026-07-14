import type { AgentTool, ToolRuntimeDeps } from '../types.js';

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 限制数值在 [min, max] 范围 */
function clampNum(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num(args, key, fallback)));
}

export function createAnalysisTools(deps: ToolRuntimeDeps): AgentTool[] {
  const getVideoInfo: AgentTool = {
    name: 'get_video_info',
    displayName: '获取视频信息',
    category: 'analysis',
    description: '获取视频时长、分辨率、帧率、编码、容器、文件大小。无参数。',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const info = await window.viewPoint.probeVideoQuality(deps.videoPath);
      return JSON.stringify(info);
    },
  };

  const transcribeAudio: AgentTool = {
    name: 'transcribe_audio',
    displayName: '语音转文字',
    category: 'analysis',
    description: '调用 LLM 全模态生成 SRT 字幕。无参数。生成后可作为后续工具的字幕依据。',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, signal) => {
      const srt = await deps.generateSrt(deps.videoPath, signal);
      deps.srtText = srt;
      return JSON.stringify({ success: true, srtLength: srt.length, srtPreview: srt.slice(0, 500) });
    },
  };

  const detectSceneChanges: AgentTool = {
    name: 'detect_scene_changes',
    displayName: '场景切换检测',
    category: 'analysis',
    description: '用 ffmpeg scene 滤镜检测场景切换点。参数: sensitivity(0~1，默认 0.3)。',
    parameters: {
      type: 'object',
      properties: {
        sensitivity: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
      },
    },
    handler: async (args) => {
      const sensitivity = clampNum(args, 'sensitivity', 0.3, 0, 1);
      const threshold = (1 - sensitivity).toFixed(4);
      const result = await window.viewPoint.ffmpegExecute({
        args: ['-i', deps.videoPath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
      });
      const timestamps = extractSceneTimestamps(result.stderr);
      return JSON.stringify({ success: result.success, scenes: timestamps, count: timestamps.length });
    },
  };

  const detectSilence: AgentTool = {
    name: 'detect_silence',
    displayName: '静音段检测',
    category: 'analysis',
    description: '用 ffmpeg silencedetect 检测静音区间。参数: minDurationSec(默认 0.5), noiseTolerance(默认 -30，单位 dB)。',
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
      const result = await window.viewPoint.ffmpegExecute({
        args: ['-i', deps.videoPath, '-af', `silencedetect=noise=${noise}dB:d=${minDuration}`, '-f', 'null', '-'],
      });
      const segments = extractSilenceSegments(result.stderr);
      return JSON.stringify({ success: result.success, silenceSegments: segments, count: segments.length });
    },
  };

  const searchSubtitles: AgentTool = {
    name: 'search_subtitles',
    displayName: '字幕关键词搜索',
    category: 'analysis',
    description: '在已有 SRT 字幕中搜索关键词，返回匹配片段及上下文。参数: srtData(SRT 文本，可省略则用视频已有字幕), keyword。',
    parameters: {
      type: 'object',
      properties: {
        srtData: { type: 'string' },
        keyword: { type: 'string' },
      },
      required: ['keyword'],
    },
    handler: async (args) => {
      const keyword = String(args.keyword ?? '').trim();
      const srt = typeof args.srtData === 'string' ? args.srtData : deps.srtText ?? '';
      if (!keyword) {
        return JSON.stringify({ success: false, error: 'keyword 不能为空' });
      }
      if (!srt) {
        return JSON.stringify({ success: false, error: '无 SRT 字幕数据，请先调用 transcribe_audio' });
      }
      const matches = searchSrt(srt, keyword);
      return JSON.stringify({ success: true, keyword, matches, count: matches.length });
    },
  };

  return [getVideoInfo, transcribeAudio, detectSceneChanges, detectSilence, searchSubtitles];
}

function extractSceneTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const re = /pts_time:(\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    timestamps.push(parseFloat(m[1]));
  }
  return timestamps;
}

function extractSilenceSegments(stderr: string): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  const startRe = /silence_start:\s*(-?\d+\.?\d*)/g;
  while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]));
  const endRe = /silence_end:\s*(-?\d+\.?\d*)/g;
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]));
  const segments: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < starts.length; i++) {
    const start = Math.max(0, starts[i]);
    const end = ends[i] ?? start;
    // 过滤无效段（end <= start）
    if (end > start) {
      segments.push({ start, end });
    }
  }
  return segments;
}

interface SrtMatch {
  index: number;
  timeStart: string;
  timeEnd: string;
  text: string;
}

function searchSrt(srt: string, keyword: string): SrtMatch[] {
  const blocks = srt.split(/\n\s*\n/);
  const matches: SrtMatch[] = [];
  const lower = keyword.toLowerCase();
  blocks.forEach((block, i) => {
    if (block.toLowerCase().includes(lower)) {
      const lines = block.trim().split('\n');
      const timeLine = lines.find((l) => l.includes('-->')) ?? '';
      const [ts, te] = timeLine.split('-->');
      matches.push({
        index: i + 1,
        timeStart: (ts ?? '').trim(),
        timeEnd: (te ?? '').trim(),
        text: lines.slice(lines.findIndex((l) => l.includes('-->')) + 1).join(' '),
      });
    }
  });
  return matches;
}
