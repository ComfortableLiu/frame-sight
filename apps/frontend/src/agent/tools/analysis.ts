import type { AgentTool, ToolRuntimeDeps } from '../types.js';
import { extractSceneTimestamps, extractSilenceSegments, clampNum, num, parseSrtCues } from './shared.js';
import { transcribeViaRecognitionConfig } from '../asr.js';

export function createAnalysisTools(deps: ToolRuntimeDeps): AgentTool[] {
  const getVideoInfo: AgentTool = {
    name: 'get_video_info',
    displayName: '获取视频信息',
    category: 'analysis',
    description: '获取视频时长、分辨率、帧率、编码、容器、文件大小。无参数。',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const info = await window.viewPoint.probeVideoQuality(deps.videoPath);
      return JSON.stringify({
        ok: true,
        title: '视频信息',
        content: { format: 'json', data: info },
        message: `时长 ${info.durationSeconds ?? '?'}s，${info.width ?? '?'}x${info.height ?? '?'}，${info.codec ?? '未知编码'}`,
      });
    },
  };

  const transcribeAudio: AgentTool = {
    name: 'transcribe_audio',
    displayName: '语音转文字',
    category: 'analysis',
    description: '语音转文字生成 SRT 字幕。优先使用设置中已启用的语音识别(ASR)服务，未配置时回退 LLM 全模态。无参数。生成后可作为后续工具的字幕依据。',
    parameters: { type: 'object', properties: {} },
    handler: async (_args, signal) => {
      // 优先使用设置中启用的语音识别服务
      const asrSrt = await transcribeViaRecognitionConfig(deps.videoPath, signal);
      const srt = asrSrt ?? (await deps.generateSrt(deps.videoPath, signal));
      deps.srtText = srt;
      const cues = parseSrtCues(srt);
      return JSON.stringify({
        ok: true,
        title: '语音转文字',
        srt,
        content: {
          format: 'json_subtitles',
          entries: cues.map((c, i) => ({ i, p: msToSrtTime(c.startMs), t: msToSrtTime(c.endMs), y: c.text })),
        },
        message: `已生成 ${cues.length} 段字幕`,
      });
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
      // 切换点 → 场景区间列表
      const points = timestamps.map((t) => Math.round(t * 1000));
      const bounds = [0, ...points];
      const totalMs = deps.durationSeconds ? Math.round(deps.durationSeconds * 1000) : 0;
      if (totalMs > bounds[bounds.length - 1]) bounds.push(totalMs);
      const scenes = bounds.slice(0, -1).map((s, i) => ({
        index: i + 1,
        startMs: s,
        endMs: bounds[i + 1],
        durationMs: bounds[i + 1] - s,
      }));
      return JSON.stringify({
        ok: result.success,
        title: '场景切换检测',
        description: `检测到 ${points.length} 个场景切换点`,
        content: { format: 'scenes', scenes, totalScenes: scenes.length, totalDurationMs: totalMs || undefined },
        message: `检测到 ${points.length} 个场景切换点，共 ${scenes.length} 个场景`,
      });
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
      const silences = segments.map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        durationMs: Math.round((s.end - s.start) * 1000),
      }));
      const totalSilenceMs = silences.reduce((sum, s) => sum + s.durationMs, 0);
      return JSON.stringify({
        ok: result.success,
        title: '静音段检测',
        description: `检测到 ${silences.length} 段静音`,
        content: { format: 'silence', silences, totalSilenceMs },
        message: `检测到 ${silences.length} 段静音，总时长 ${(totalSilenceMs / 1000).toFixed(1)} 秒`,
      });
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
        return JSON.stringify({ ok: false, error: 'keyword 不能为空' });
      }
      if (!srt) {
        return JSON.stringify({ ok: false, error: '无 SRT 字幕数据，请先调用 transcribe_audio' });
      }
      const matches = searchSrt(srt, keyword);
      return JSON.stringify({
        ok: true,
        title: '字幕关键词搜索',
        content: {
          format: 'search_results',
          keyword,
          matchCount: matches.length,
          results: matches.map((m, i) => ({
            matchIndex: i,
            start: m.timeStart,
            end: m.timeEnd,
            before: '',
            match: m.text,
            after: '',
          })),
        },
        message: `关键词「${keyword}」共 ${matches.length} 处匹配`,
      });
    },
  };

  return [getVideoInfo, transcribeAudio, detectSceneChanges, detectSilence, searchSubtitles];
}

/** 毫秒 → SRT 时间戳（HH:MM:SS,mmm）。 */
function msToSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
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
