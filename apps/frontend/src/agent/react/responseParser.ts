import type { ParsedAgentResponse, TodoItem } from '../types.js';
import { extractFirstJsonObject, parseToolCallFromText } from './parser.js';

/**
 * 统一解析 LLM 输出：提取 tool_call、done 信号、todos_added/todos_updated JSON。
 */
export function parseAgentResponse(raw: string): ParsedAgentResponse {
  const text = raw ?? '';

  const toolCall = parseToolCallFromText(text);

  const doneSignal = extractDoneSignal(text);

  const todosAdded = extractTodosArray(text, 'todos_added');
  const todosUpdated = extractTodosUpdates(text);

  return {
    toolCall,
    doneSignal,
    todosAdded,
    todosUpdated,
    initialTodos: null,
    rawText: text,
  };
}

/**
 * 首轮解析：提取 ```todos 代码块作为 initialTodos + 首个 tool_call。
 */
export function parseFirstTurnResponse(raw: string): ParsedAgentResponse {
  const text = raw ?? '';
  const base = parseAgentResponse(text);
  const initialTodos = extractInitialTodos(text) ?? extractTodosHeuristically(text);
  return { ...base, initialTodos };
}

/** 从 ```todos 围栏提取 JSON 数组。 */
function extractInitialTodos(text: string): TodoItem[] | null {
  const fenced = text.match(/```todos\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : null;
  if (!candidate) return null;
  const arr = extractFirstJsonArray(candidate);
  if (!arr) return null;
  return arr.map(normalizeTodoItem).filter(Boolean) as TodoItem[];
}

function extractFirstJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
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
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function extractDoneSignal(text: string): { todoId?: string } | null {
  // {"status":"done","todo_id":"t1"} 或 {"status":"done"}
  const json = extractFirstJsonObject(text);
  if (json && json.status === 'done') {
    const todoId = typeof json.todo_id === 'string' ? json.todo_id : undefined;
    return { todoId };
  }
  return null;
}

function extractTodosArray(text: string, key: string): TodoItem[] | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  const arr = json[key];
  if (!Array.isArray(arr)) return null;
  return arr.map(normalizeTodoItem).filter(Boolean) as TodoItem[];
}

function extractTodosUpdates(
  text: string,
): Array<Partial<TodoItem> & { id: string }> | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  const arr = json.todos_updated;
  if (!Array.isArray(arr)) return null;
  const result: Array<Partial<TodoItem> & { id: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const update: Partial<TodoItem> & { id: string } = { id };
    if (typeof (item as { status?: unknown }).status === 'string') {
      update.status = (item as { status: TodoItem['status'] }).status;
    }
    if (typeof (item as { description?: unknown }).description === 'string') {
      update.description = (item as { description: string }).description;
    }
    if (typeof (item as { lastError?: unknown }).lastError === 'string') {
      update.lastError = (item as { lastError: string }).lastError;
    }
    result.push(update);
  }
  return result.length ? result : null;
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : `t_${Math.random().toString(36).slice(2, 8)}`;
  const description =
    typeof obj.description === 'string'
      ? obj.description
      : typeof obj.desc === 'string'
        ? obj.desc
        : '';
  if (!description) return null;
  const status = normalizeStatus(obj.status);
  return {
    id,
    description,
    toolHint: typeof obj.toolHint === 'string' ? obj.toolHint : undefined,
    status,
    attempts: 0,
  };
}

function normalizeStatus(value: unknown): TodoItem['status'] {
  if (value === 'done' || value === 'in_progress' || value === 'pending') return value;
  return 'pending';
}

/**
 * 首轮未返回合法 ```todos 时的降级方案：从 Markdown 标题/编号列表提取计划行。
 */
export function extractTodosHeuristically(text: string): TodoItem[] | null {
  const lines = text.split('\n');
  const todos: TodoItem[] = [];
  let idx = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    // Markdown 标题 ## 或 ### 或编号 1. / - / *
    const heading = trimmed.match(/^#{1,4}\s+(.+)/);
    const numbered = trimmed.match(/^(?:\d+[.)]|[-*])\s+(.+)/);
    const match = heading || numbered;
    if (match) {
      const desc = match[1].trim();
      // 过滤明显非计划行
      if (desc.length < 2 || desc.length > 120) continue;
      if (/^(tool_call|todos|用户需求|CURRENT_TASK|IGNORE)/i.test(desc)) continue;
      todos.push({
        id: `t${idx++}`,
        description: desc,
        status: 'pending',
        attempts: 0,
      });
    }
  }
  return todos.length ? todos : null;
}
