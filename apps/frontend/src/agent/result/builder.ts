import type {
  MediaItem,
  ResultButton,
  ResultPayload,
  ToolCallResult,
  ToolReturnPayload,
  VideoContext,
} from '../types.js';
import { hasResultPayload, parseResultPayload } from './protocol.js';

/**
 * QA 结果：纯文本回答 + 查看报告/字幕按钮。
 */
export function buildQAResultPayload(
  answer: string,
  videoContext: VideoContext,
): ResultPayload {
  const buttonList: ResultButton[] = [];
  if (videoContext.structuredReport) {
    buttonList.push({
      id: 'view-report',
      label: '查看拉片报告',
      action: 'open',
      openTarget: 'view-report',
    });
  }
  if (videoContext.srtText) {
    buttonList.push({
      id: 'view-srt',
      label: '查看字幕',
      action: 'open',
      openTarget: 'view-srt',
    });
  }
  return { text: stripAgentResultFence(answer), buttonList };
}

/**
 * 工具结果：最终回答 + 从工具结果提取媒体项，并为每个媒体项生成
 * 「预览」和「新窗口打开」两个按钮（结构化报告格式规范 §3.4）。
 */
export function buildToolResultPayload(
  finalAnswer: string,
  toolResults: ToolCallResult[],
): ResultPayload {
  const mediaList = extractMediaFromToolResults(toolResults);
  const buttonList: ResultButton[] = [];
  mediaList.forEach((media, index) => {
    buttonList.push({
      id: `btn-preview-${index}`,
      label: `预览 ${media.title}`,
      action: 'preview',
      mediaIndex: index,
    });
    buttonList.push({
      id: `btn-open-${index}`,
      label: '新窗口打开',
      action: 'download',
      url: media.url,
    });
  });
  return {
    text: stripAgentResultFence(finalAnswer),
    mediaList: mediaList.length ? mediaList : undefined,
    buttonList: buttonList.length ? buttonList : undefined,
  };
}

/** 解析工具返回 JSON 为 ToolReturnPayload；非 JSON 返回 null。 */
export function parseToolReturn(output: string): ToolReturnPayload | null {
  try {
    const json = JSON.parse(output);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return json as ToolReturnPayload;
    }
  } catch {
    // 非 JSON
  }
  return null;
}

/**
 * 遍历工具结果 JSON，提取 wosUrl/finalUrl（兼容 objectUrl），去重生成 MediaItem。
 * 标题取工具返回的 title ?? message ?? 工具名。
 */
export function extractMediaFromToolResults(toolResults: ToolCallResult[]): MediaItem[] {
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const result of toolResults) {
    if (!result.success || !result.output) continue;
    const parsed = parseToolReturn(result.output);
    const title = parsed?.title ?? parsed?.message ?? `${result.toolName} 产物`;
    for (const url of mediaUrlsOf(parsed, result.output)) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({ title, url, type: guessType(url), fromTool: result.toolName });
    }
  }
  return items;
}

/** 按规范提取媒体 URL：优先 wosUrl/finalUrl 字段，兼容 objectUrl，兜底正则扫描。 */
function mediaUrlsOf(parsed: ToolReturnPayload | null, rawOutput: string): string[] {
  if (parsed) {
    const urls: string[] = [];
    for (const key of ['wosUrl', 'finalUrl', 'objectUrl'] as const) {
      const v = parsed[key];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) urls.push(v);
    }
    if (urls.length) return urls;
  }
  // 兜底：正则扫描裸 URL
  const urls: string[] = [];
  const re = /https?:\/\/[^\s"')]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawOutput)) !== null) urls.push(m[0]);
  return urls;
}

/** 按扩展名识别媒体类型（规范 §5.3）。 */
function guessType(url: string): MediaItem['type'] {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.aac') || lower.endsWith('.m4a')) return 'audio';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) return 'image';
  return 'video';
}

/**
 * 剥离 LLM 模仿历史消息中的 agent_result 围栏，防止双重嵌套。
 */
export function stripAgentResultFence(text: string): string {
  if (!hasResultPayload(text)) return text;
  const parsed = parseResultPayload(text);
  if (parsed) return parsed.text;
  // 解析失败则手动剥离围栏
  return text.replace(/```agent_result\s*[\s\S]*?```/g, '').trim();
}
