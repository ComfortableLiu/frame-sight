import type { LlmCaller, LlmEndpoint, LlmMessage } from '../types.js';
import { estimateTokens } from './caller.js';

const DEFAULT_CONTEXT_WINDOW = 200000;
const COMPLETION_RESERVE = 8000; // maxTokens 默认
const OVERHEAD_RESERVE = 8192; // 工具输出/系统开销
const KEEP_RECENT_TURNS = 6; // 保留最近 6 轮（12 条消息）
const SINGLE_MESSAGE_LIMIT = 8000;
const TRUNCATE_KEEP_RATIO = 0.9;

/**
 * 派生压缩阈值：contextWindow - maxTokens - 预留余量。
 * maxContextTokens 显式传入时覆盖。
 */
export function deriveContextLimit(
  endpoint: LlmEndpoint | undefined,
  maxContextTokens?: number,
  maxTokens?: number,
): number {
  if (typeof maxContextTokens === 'number') return maxContextTokens;
  const contextWindow = endpoint?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const completion = maxTokens ?? COMPLETION_RESERVE;
  return Math.max(8000, contextWindow - completion - OVERHEAD_RESERVE);
}

/** 移除 <thinking>...</thinking> 围栏内容（含未闭合标签）。 */
export function filterThinkingFromMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => {
    let content = m.content;
    // 闭合的 <thinking>...</thinking>
    content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    // 未闭合的 <thinking>... 到末尾
    content = content.replace(/<thinking>[\s\S]*$/g, '');
    return { ...m, content: content.trim() };
  });
}

function truncateIfTooLong(message: LlmMessage): LlmMessage {
  const tokens = estimateTokens(message.content);
  if (tokens <= SINGLE_MESSAGE_LIMIT) return message;
  const keepChars = Math.floor(message.content.length * TRUNCATE_KEEP_RATIO);
  return {
    ...message,
    content:
      message.content.slice(0, keepChars) +
      `\n…[已截断，原始约 ${tokens} tokens]`,
  };
}

/** 单条消息超过 8000 token 按比例截断，保留约 90%。 */
export function truncateMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(truncateIfTooLong);
}

/**
 * 估算消息列表 token（兜底用）。有最近 usage 基准时由调用方叠加增量。
 */
export function estimateMessagesTokens(messages: LlmMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * 计算当前上下文占用：
 * 以最近一次 usage.promptTokens 为基准，叠加其后新增消息的 estimateTokens 增量。
 * 无 usage 时全量 estimateTokens。
 */
export function estimateOccupancy(
  messages: LlmMessage[],
  lastUsagePromptTokens: number | null,
  usageBaselineMessageCount: number,
): number {
  if (lastUsagePromptTokens == null) {
    return estimateMessagesTokens(messages);
  }
  // baseline 可能大于当前消息数（历史被替换），取 min
  const baseline = Math.min(usageBaselineMessageCount, messages.length);
  const tail = messages.slice(baseline);
  return lastUsagePromptTokens + estimateMessagesTokens(tail);
}

async function summarizeMessages(
  caller: LlmCaller,
  messages: LlmMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const conversation = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');
  const prompt: LlmMessage[] = [
    {
      role: 'system',
      content:
        '你是对话摘要助手。将以下对话压缩为：1) 整体操作总结（一段话）；2) 关键事实列表（带时间戳/文件名等）。保留所有用户意图与已产出结果，删除冗余。',
    },
    { role: 'user', content: conversation },
  ];
  return caller(prompt, { signal, maxTokens: 2000 });
}

/**
 * 启动时上下文压缩：超阈值时保留最近 6 轮，更早的用 LLM 摘要。
 */
export async function ensureContextWithinLimit(
  caller: LlmCaller,
  messages: LlmMessage[],
  opts: {
    limit: number;
    lastUsagePromptTokens: number | null;
    usageBaselineMessageCount: number;
    signal?: AbortSignal;
  },
): Promise<LlmMessage[]> {
  const cleaned = truncateMessages(filterThinkingFromMessages(messages));
  let occupancy = estimateOccupancy(
    cleaned,
    opts.lastUsagePromptTokens,
    opts.usageBaselineMessageCount,
  );
  if (occupancy <= opts.limit) return cleaned;

  const keepCount = KEEP_RECENT_TURNS * 2;

  // 消息数 <= keepCount 但仍超限：对每条消息做更激进截断
  if (cleaned.length <= keepCount) {
    const aggressive = cleaned.map((m) => {
      const tokens = estimateTokens(m.content);
      if (tokens <= SINGLE_MESSAGE_LIMIT / 2) return m;
      const keepChars = Math.floor(m.content.length * 0.5);
      return { ...m, content: m.content.slice(0, keepChars) + '\n…[已压缩]' };
    });
    const newOccupancy = estimateOccupancy(aggressive, opts.lastUsagePromptTokens, opts.usageBaselineMessageCount);
    if (newOccupancy <= opts.limit) return aggressive;
    // 仍超限，只保留最后几条
    return aggressive.slice(-Math.max(2, Math.floor(keepCount / 2)));
  }

  const toCompress = cleaned.slice(0, cleaned.length - keepCount);
  const keep = cleaned.slice(cleaned.length - keepCount);

  // toCompress 本身可能超限，先截断再摘要
  const truncatedForSummary = toCompress.map((m) => {
    const tokens = estimateTokens(m.content);
    if (tokens <= SINGLE_MESSAGE_LIMIT) return m;
    const keepChars = Math.floor(m.content.length * 0.5);
    return { ...m, content: m.content.slice(0, keepChars) + '\n…[已截断]' };
  });

  const summary = await summarizeMessages(caller, truncatedForSummary, opts.signal);
  const summaryMsg: LlmMessage = {
    role: 'system',
    content: `[历史摘要]\n${summary}`,
  };
  return [summaryMsg, ...keep];
}

/**
 * 循环中增量压缩：每步检查，超阈值时压缩最早批次，保留最近 6 轮。
 */
export async function compressMessagesIfNeeded(
  caller: LlmCaller,
  messages: LlmMessage[],
  opts: {
    limit: number;
    lastUsagePromptTokens: number | null;
    usageBaselineMessageCount: number;
    signal?: AbortSignal;
  },
): Promise<LlmMessage[]> {
  return ensureContextWithinLimit(caller, messages, opts);
}

/**
 * 保留最近 3 步完整内容，较早的压缩为状态摘要。
 * 用于 ReAct 步骤消息的压缩。
 */
export function compressOldStepMessages(
  messages: LlmMessage[],
  isStepMessage: (m: LlmMessage) => boolean,
  keepSteps = 3,
): LlmMessage[] {
  const indices: number[] = [];
  messages.forEach((m, i) => {
    if (isStepMessage(m)) indices.push(i);
  });
  if (indices.length <= keepSteps) return messages;

  const cutoff = indices[indices.length - keepSteps];
  const head = messages.slice(0, cutoff);
  const tail = messages.slice(cutoff);

  const stepCount = head.filter(isStepMessage).length;
  const summary: LlmMessage = {
    role: 'system',
    content: `[已压缩 ${stepCount} 个早期工具步骤，详见 TODO 状态]`,
  };
  // 仅保留非步骤消息 + 摘要
  const headKept = head.filter((m) => !isStepMessage(m));
  return [...headKept, summary, ...tail];
}
