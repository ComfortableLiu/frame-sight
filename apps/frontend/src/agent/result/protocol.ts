import type { ResultPayload } from '../types.js';

const FENCE = 'agent_result';

/**
 * 序列化：用 ```agent_result 围栏包裹 JSON。
 */
export function serializeResultPayload(payload: ResultPayload): string {
  const json = JSON.stringify(payload);
  return '```' + FENCE + '\n' + json + '\n```';
}

/**
 * 判断消息是否含 agent_result 围栏。
 */
export function hasResultPayload(messageContent: string): boolean {
  return messageContent.includes('```' + FENCE);
}

/**
 * 解析：支持嵌套围栏与裸 JSON 兜底。
 */
export function parseResultPayload(messageContent: string): ResultPayload | null {
  if (!messageContent) return null;

  // 取最后一个 agent_result 围栏（防止历史消息污染）
  const regex = new RegExp('```' + FENCE + '\\s*([\\s\\S]*?)```', 'g');
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(messageContent)) !== null) {
    lastMatch = m[1];
  }
  if (lastMatch) {
    const parsed = tryParse(lastMatch);
    if (parsed) return parsed;
  }

  // 裸 JSON 兜底：尝试整体解析
  const direct = tryParse(messageContent);
  if (direct) return direct;

  // 尝试提取第一个 { ... } 并解析
  const obj = extractFirstJsonObject(messageContent);
  if (obj && typeof obj.text === 'string') return obj as unknown as ResultPayload;
  return null;
}

function tryParse(candidate: string): ResultPayload | null {
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed.text === 'string') {
      return parsed as ResultPayload;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}
