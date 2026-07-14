import type {
  MediaItem,
  ResultButton,
  ResultPayload,
  ToolCallResult,
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
    });
  }
  if (videoContext.srtText) {
    buttonList.push({
      id: 'view-srt',
      label: '查看字幕',
      action: 'open',
    });
  }
  return { text: stripAgentResultFence(answer), buttonList };
}

/**
 * 工具结果：最终回答 + 从工具结果提取媒体项 → 预览按钮。
 */
export function buildToolResultPayload(
  finalAnswer: string,
  toolResults: ToolCallResult[],
): ResultPayload {
  const mediaList = extractMediaFromToolResults(toolResults);
  const buttonList: ResultButton[] = mediaList.map((media, index) => ({
    id: `preview-${index}`,
    label: media.title,
    action: 'preview' as const,
    mediaIndex: index,
  }));
  return {
    text: stripAgentResultFence(finalAnswer),
    mediaList: mediaList.length ? mediaList : undefined,
    buttonList: buttonList.length ? buttonList : undefined,
  };
}

/**
 * 遍历工具结果 JSON，提取 objectUrl/finalUrl，去重生成 MediaItem。
 */
export function extractMediaFromToolResults(toolResults: ToolCallResult[]): MediaItem[] {
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const result of toolResults) {
    if (!result.success || !result.output) continue;
    const urls = extractUrls(result.output);
    for (const { url, type } of urls) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({
        title: `${result.toolName} 产物`,
        url,
        type,
        fromTool: result.toolName,
      });
    }
  }
  return items;
}

interface ExtractedUrl {
  url: string;
  type: MediaItem['type'];
}

function extractUrls(output: string): ExtractedUrl[] {
  const urls: ExtractedUrl[] = [];
  try {
    const json = JSON.parse(output);
    collectUrls(json, urls);
  } catch {
    // 非 JSON，尝试正则提取 URL
    const re = /https?:\/\/[^\s"')]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      urls.push({ url: m[0], type: guessType(m[0]) });
    }
  }
  return urls;
}

function collectUrls(node: unknown, urls: ExtractedUrl[]): void {
  if (!node) return;
  if (typeof node === 'string') {
    if (/^https?:\/\//.test(node)) {
      urls.push({ url: node, type: guessType(node) });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUrls(item, urls);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of ['objectUrl', 'finalUrl', 'wosUrl', 'url']) {
      const v = obj[key];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) {
        urls.push({ url: v, type: guessType(v) });
      }
    }
    for (const v of Object.values(obj)) collectUrls(v, urls);
  }
}

function guessType(url: string): MediaItem['type'] {
  const lower = url.toLowerCase();
  if (lower.endsWith('.gif')) return 'gif';
  if (lower.endsWith('.mp3') || lower.endsWith('.wav') || lower.endsWith('.m4a')) return 'audio';
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
