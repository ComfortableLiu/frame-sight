import type {
  AgentRunCallbacks,
  AgentRunConfig,
  AgentTool,
  ConversationContext,
  LlmCaller,
  LlmMessage,
  ReActLoopOutput,
  ReActStep,
  TodoItem,
  ToolCallResult,
  VideoContext,
  AgentTaskState,
} from '../types.js';
import {
  buildFirstTurnPrompt,
  buildReActSystemPrompt,
  buildSubsequentTurnPrompt,
  buildToolResultMessage,
  filterThinkingFromMessages,
} from './promptBuilder.js';
import { parseAgentResponse, parseFirstTurnResponse } from './responseParser.js';
import { compressMessagesIfNeeded, deriveContextLimit } from '../llm/contextManager.js';
import { parseToolReturn } from '../result/builder.js';
import type { ToolRegistry } from '../tools/registry.js';

const ABSOLUTE_MAX_ITERATIONS = 50;

export interface ReActLoopInput {
  userInput: string;
  videoContext: VideoContext;
  conversationContext: ConversationContext;
  llmCaller: LlmCaller;
  /** 统一工具注册表（含运行时动态注册的工具） */
  tools: ToolRegistry;
  taskState?: AgentTaskState;
  config?: AgentRunConfig;
  callbacks?: AgentRunCallbacks;
  endpoint?: import('../types.js').LlmEndpoint;
  signal?: AbortSignal;
  maxTokens?: number;
  /** 动态脚本工具按 run 隔离 */
  runId?: string;
}

export async function runReActLoop(input: ReActLoopInput): Promise<ReActLoopOutput> {
  const {
    userInput,
    videoContext,
    conversationContext,
    llmCaller,
    callbacks,
    signal,
    maxTokens = 8000,
  } = input;

  // 统一工具注册表（动态工具运行时注册）
  const registry = input.tools;

  let todos: TodoItem[] = [];
  const steps: ReActStep[] = [];

  // 上下文计量状态
  let lastUsagePromptTokens: number | null = null;
  let usageBaselineMessageCount = 0;
  const limit = deriveContextLimit(input.endpoint, input.config?.maxContextTokens, maxTokens);

  const messages: LlmMessage[] = [
    { role: 'system', content: buildReActSystemPrompt(videoContext, registry.list(), input.taskState) },
    ...conversationMessagesToLlm(conversationContext),
  ];

  let stepIndex = 0;
  let truncated = false;
  let finalAnswer = '';
  const maxToolSteps = input.config?.maxToolSteps ?? 12;
  /** 模型未按协议输出（无 tool_call 且未完成）时的格式重试次数 */
  let formatRetries = 0;
  const MAX_FORMAT_RETRIES = 2;
  /** 格式重试时替代标准轮次提示的自定义提示 */
  let customReprompt: string | null = null;

  // 工具集变化（如动态工具注册）时刷新系统提示中的工具表
  registry.onChange(() => {
    if (messages[0]?.role === 'system') {
      messages[0] = {
        role: 'system',
        content: buildReActSystemPrompt(videoContext, registry.list(), input.taskState),
      };
    }
  });

  while (stepIndex < ABSOLUTE_MAX_ITERATIONS) {
    // 终止：全部 done
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      finalAnswer = await generateFinalAnswer(llmCaller, messages, signal, maxTokens, callbacks);
      break;
    }

    // 终止：达到工具步数上限
    if (steps.length >= maxToolSteps) {
      finalAnswer = await generateFinalAnswer(llmCaller, messages, signal, maxTokens, callbacks);
      truncated = true;
      break;
    }

    const isFirstTurn = stepIndex === 0;
    const userPrompt =
      customReprompt ??
      (isFirstTurn
        ? buildFirstTurnPrompt(userInput)
        : buildSubsequentTurnPrompt(
            todos,
            selectFocusTodo(todos),
            steps.length ? steps[steps.length - 1].result.error : undefined,
          ));
    customReprompt = null;
    messages.push({ role: 'user', content: userPrompt });

    callbacks?.onStageChange?.({
      kind: 'react_planning',
    });

    // 增量上下文压缩
    const compressed = await compressMessagesIfNeeded(llmCaller, messages, {
      limit,
      lastUsagePromptTokens,
      usageBaselineMessageCount,
      signal,
    });
    if (compressed.length !== messages.length) {
      messages.length = 0;
      messages.push(...compressed);
      usageBaselineMessageCount = messages.length;
      lastUsagePromptTokens = null;
    }

    let raw: string;
    try {
      raw = await llmCaller(filterThinkingFromMessages(messages), {
        signal,
        maxTokens,
        onUsage: (u) => {
          lastUsagePromptTokens = u.promptTokens;
          usageBaselineMessageCount = messages.length;
        },
        onDelta: (acc) => callbacks?.onLlmDelta?.(acc),
      });
    } catch (err) {
      // LLM 调用失败：中止当前轮，记录错误并退出循环
      const message = err instanceof Error ? err.message : String(err);
      callbacks?.onStageChange?.({ kind: 'error', message });
      finalAnswer = `⚠️ LLM 调用失败：${message}`;
      break;
    }
    messages.push({ role: 'assistant', content: raw });

    const parsed = isFirstTurn ? parseFirstTurnResponse(raw) : parseAgentResponse(raw);
    if (isFirstTurn && parsed.initialTodos && parsed.initialTodos.length) {
      todos = parsed.initialTodos;
      callbacks?.onTodosReady?.(todos);
    }

    // 应用 todos 调整
    todos = applyTodoUpdates(todos, parsed, callbacks);

    if (!parsed.toolCall) {
      // 无工具调用 → 可能是最终总结或仅 done 信号
      if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
        finalAnswer = raw;
        break;
      }
      // 任务未完成但模型未按协议输出（无 tool_call）→ 提醒格式后重试，避免直接放弃
      if (formatRetries < MAX_FORMAT_RETRIES) {
        formatRetries += 1;
        customReprompt = todos.length
          ? '请输出 ```tool_call 代码块（JSON: {name, arguments}）推进当前 TODO；若全部完成则输出最终 Markdown 总结。不要输出其他内容。'
          : '你的回复未按要求的格式输出。请先输出 ```todos 代码块（JSON 数组，每项 {id, description, toolHint?}），再输出 ```tool_call 代码块（JSON: {name, arguments}）。请重新输出，不要输出其他内容。';
        continue;
      }
      // 重试仍无工具调用 → 生成最终回答
      finalAnswer = await generateFinalAnswer(llmCaller, messages, signal, maxTokens, callbacks);
      // 模型以总结收尾：剩余 TODO 标记完成并同步 UI
      if (todos.some((t) => t.status !== 'done')) {
        todos = todos.map((t) => (t.status === 'done' ? t : { ...t, status: 'done' as const }));
        callbacks?.onTodoUpdate?.(todos, todos.map((t) => t.id));
      }
      break;
    }

    const tool = registry.get(parsed.toolCall.name);
    const stepResult = await executeTool(
      parsed.toolCall.name,
      parsed.toolCall.arguments,
      tool,
      input.callbacks,
      stepIndex,
      signal,
    );
    steps.push({
      stepIndex,
      toolName: parsed.toolCall.name,
      toolDisplayName: tool?.displayName ?? parsed.toolCall.name,
      args: parsed.toolCall.arguments,
      result: stepResult,
    });
    // 通知 UI：将执行过程追加到聊天列表
    callbacks?.onReActStep?.(steps[steps.length - 1]);

    // 动态工具注册：结果中含工具描述时由注册表统一接管
    if (stepResult.success) {
      registry.registerDynamicFromResult(stepResult, input.runId ?? '');
    }

    // 更新 focus TODO 状态与失败计数
    const focusBefore = todos.find((t) => t.status === 'in_progress')?.id;
    todos = updateFocusAfterToolCall(todos, parsed.toolCall.name, stepResult);
    // updateFocusAfterToolCall 不发通知，这里同步 UI（否则最后一项完成后仍显示进行中）
    if (focusBefore) callbacks?.onTodoUpdate?.(todos, [focusBefore]);

    messages.push(buildToolResultMessage(parsed.toolCall.name, stepResult));

    stepIndex += 1;
  }

  if (stepIndex >= ABSOLUTE_MAX_ITERATIONS && !finalAnswer) {
    truncated = true;
    finalAnswer = await generateFinalAnswer(llmCaller, messages, signal, maxTokens, callbacks);
  }

  callbacks?.onStageChange?.({ kind: 'react_finalizing' });

  return { todos, steps, finalAnswer, truncated };
}

function conversationMessagesToLlm(ctx: ConversationContext): LlmMessage[] {
  return ctx.messages.map((m) => ({ role: m.role, content: m.content }));
}

export function selectFocusTodo(todos: TodoItem[]): TodoItem | null {
  return todos.find((t) => t.status === 'pending' || t.status === 'in_progress') ?? null;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tool: AgentTool | undefined,
  callbacks: AgentRunCallbacks | undefined,
  stepIndex: number,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  if (!tool) {
    return {
      toolName: name,
      success: false,
      output: '',
      error: `未找到工具: ${name}`,
    };
  }
  const start = Date.now();
  callbacks?.onStageChange?.({
    kind: 'react_executing',
    stepIndex,
    toolName: name,
    toolDisplayName: tool.displayName,
  });
  try {
    const output = await tool.handler(args, signal);
    // 结构化报告协议：工具返回 { ok: false }（或旧字段 success: false）视为执行失败
    const parsed = parseToolReturn(output);
    if (parsed && (parsed.ok === false || parsed.success === false)) {
      return {
        toolName: name,
        success: false,
        output,
        error: typeof parsed.error === 'string' ? parsed.error : '工具返回失败',
        durationMs: Date.now() - start,
      };
    }
    return {
      toolName: name,
      success: true,
      output,
      durationMs: Date.now() - start,
      audit: output ? tryExtractAudit(output) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      toolName: name,
      success: false,
      output: '',
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

function tryExtractAudit(output: string): ToolCallResult['audit'] {
  try {
    const json = JSON.parse(output);
    if (json?.audit) return json.audit as ToolCallResult['audit'];
  } catch {
    // 非 JSON
  }
  return undefined;
}

/**
 * 应用 TODO 更新：
 * - 焦点 TODO 标记 in_progress
 * - 处理 done 信号
 * - 处理 todos_added（id 冲突自动处理）
 * - 处理 todos_updated（禁改已 done）
 */
export function applyTodoUpdates(
  todos: TodoItem[],
  parsed: { doneSignal: { todoId?: string } | null; todosAdded: TodoItem[] | null; todosUpdated: Array<Partial<TodoItem> & { id: string }> | null },
  callbacks?: AgentRunCallbacks,
): TodoItem[] {
  let next = [...todos];
  const changedIds: string[] = [];

  // done 信号
  if (parsed.doneSignal?.todoId) {
    const id = parsed.doneSignal.todoId;
    const idx = next.findIndex((t) => t.id === id);
    if (idx >= 0 && next[idx].status !== 'done') {
      next[idx] = { ...next[idx], status: 'done' };
      changedIds.push(id);
    }
  }

  // todos_added（id 冲突重命名）
  if (parsed.todosAdded) {
    for (const item of parsed.todosAdded) {
      let id = item.id;
      while (next.some((t) => t.id === id)) {
        id = `${id}_${Math.random().toString(36).slice(2, 5)}`;
      }
      next.push({ ...item, id });
      changedIds.push(id);
    }
  }

  // todos_updated（禁改已 done）
  if (parsed.todosUpdated) {
    for (const upd of parsed.todosUpdated) {
      const idx = next.findIndex((t) => t.id === upd.id);
      if (idx < 0) continue;
      if (next[idx].status === 'done') continue; // 不允许修改已 done
      next[idx] = { ...next[idx], ...upd };
      changedIds.push(upd.id);
    }
  }

  // 焦点标记 in_progress
  const focus = selectFocusTodo(next);
  if (focus && focus.status === 'pending') {
    const idx = next.findIndex((t) => t.id === focus.id);
    next[idx] = { ...next[idx], status: 'in_progress' };
    changedIds.push(focus.id);
  }

  if (changedIds.length) {
    callbacks?.onTodoUpdate?.(next, Array.from(new Set(changedIds)));
  }

  return next;
}

function updateFocusAfterToolCall(
  todos: TodoItem[],
  toolName: string,
  result: ToolCallResult,
): TodoItem[] {
  const next = [...todos];
  const focusIdx = next.findIndex((t) => t.status === 'in_progress');
  if (focusIdx < 0) return next;
  const focus = next[focusIdx];
  if (result.success) {
    // 成功则标记 done
    next[focusIdx] = { ...focus, status: 'done' };
  } else {
    next[focusIdx] = {
      ...focus,
      attempts: focus.attempts + 1,
      lastError: result.error,
    };
  }
  return next;
}

async function generateFinalAnswer(
  caller: LlmCaller,
  messages: LlmMessage[],
  signal: AbortSignal | undefined,
  maxTokens: number,
  callbacks: AgentRunCallbacks | undefined,
): Promise<string> {
  callbacks?.onStageChange?.({ kind: 'react_finalizing' });
  messages.push({
    role: 'user',
    content: '所有 TODO 已完成。请输出最终 Markdown 总结，包含：完成的工作、产出文件/URL、关键时间戳。不要调用工具。',
  });
  const answer = await caller(filterThinkingFromMessages(messages), {
    signal,
    maxTokens,
    onDelta: (acc) => callbacks?.onLlmDelta?.(acc),
  });
  return answer;
}

