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
  // 扫描所有 JSON 对象（模型可能在 tool_call 前输出 todos 等其他 JSON），
  // 取第一个含 name+arguments 的
  for (const json of extractJsonObjects(candidate)) {
    if (typeof json.name === 'string' && json.arguments && typeof json.arguments === 'object') {
      return { name: json.name, arguments: json.arguments as Record<string, unknown> };
    }
  }
  return null;
}

export function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  return extractJsonObjects(text)[0] ?? null;
}

/** 平衡花括号扫描，提取文本中所有可解析的 JSON 对象。 */
export function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
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
            end = i;
            break;
          }
        }
      }
    }
    if (end === -1) {
      // 外层未闭合（模型多/少写了括号）：前移一位，尝试内层嵌套对象
      start = text.indexOf('{', start + 1);
      continue;
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        results.push(parsed as Record<string, unknown>);
      }
      start = text.indexOf('{', end + 1);
    } catch {
      // 外层不是合法 JSON：前移一位，给内层嵌套对象一个机会
      start = text.indexOf('{', start + 1);
    }
  }
  return results;
}
