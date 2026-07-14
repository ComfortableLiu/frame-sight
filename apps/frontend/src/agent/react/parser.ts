import type { ToolCall } from '../types.js';

/**
 * 从文本中解析 tool_call。三模式：标准围栏 / 容错格式 / 裸 JSON。
 */
export function parseToolCallFromText(text: string): ToolCall | null {
  // 1. 标准 ```tool_call 围栏
  const fenced = text.match(/```tool_call\s*([\s\S]*?)```/i);
  if (fenced) {
    const call = tryParseToolCall(fenced[1]);
    if (call) return call;
  }
  // 2. 容错：```json 或 ``` 围栏中含 "name" + "arguments"
  const anyFenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (anyFenced) {
    const call = tryParseToolCall(anyFenced[1]);
    if (call) return call;
  }
  // 3. 裸 JSON：第一个含 name+arguments 的 {...}
  const call = tryParseToolCall(text);
  return call;
}

function tryParseToolCall(candidate: string): ToolCall | null {
  const json = extractFirstJsonObject(candidate);
  if (!json) return null;
  if (typeof json.name === 'string' && json.arguments && typeof json.arguments === 'object') {
    return { name: json.name, arguments: json.arguments as Record<string, unknown> };
  }
  return null;
}

export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // 平衡花括号扫描
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
