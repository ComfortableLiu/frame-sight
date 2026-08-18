import type {
  AgentIntent,
  AgentTaskState,
  ConversationContext,
  IntentResult,
  LlmCaller,
  LlmMessage,
  TaskRoute,
} from '../types.js';

const TOOL_KEYWORDS =
  /(剪辑|裁剪|裁切|拼接|合并|导出|去静音|去无声|烧字幕|烧录字幕|加字幕|转\s*gif|转gif|加速|减速|变速|生成|制作|截取|截段|抽帧|提取片段|加水印|去水印|调色|转码|压缩|裁剪掉|删掉|删除片段)/i;

const QA_KEYWORDS =
  /(讲了什么|说了什么|总结|分析一下|分析|时长|分辨率|帧率|谁在说|谁说的|解释|为什么|是什么|有哪些|是什么内容|主要内容|关键词|话题|主旨|摘要)/i;

const CONTINUATION_HINT = /(继续|接着|然后|还有|接下来|再做|再做一遍)/;
const CORRECTION_HINT = /(不用|不要|换|改|修正|重新|调整|别用|改为|改成|重新来)/;

/** 快速规则匹配。命中且置信度 ≥ 0.8 时直接返回。 */
export function quickRuleMatch(userInput: string): IntentResult | null {
  const isTool = TOOL_KEYWORDS.test(userInput);
  const isQa = QA_KEYWORDS.test(userInput);
  if (isTool && !isQa) {
    return { intent: 'tool', confidence: 0.85, reasoning: '命中工具关键词' };
  }
  if (isQa && !isTool) {
    return { intent: 'qa', confidence: 0.8, reasoning: '命中问答关键词' };
  }
  if (isTool && isQa) {
    // 两者都命中，偏向工具（有副作用需求优先）
    return { intent: 'tool', confidence: 0.8, reasoning: '同时命中工具与问答关键词，偏向工具' };
  }
  return null;
}

/** LLM 分类。解析失败默认 qa。 */
export async function llmClassify(
  caller: LlmCaller,
  userInput: string,
  conversation: ConversationContext,
  taskState?: AgentTaskState,
  signal?: AbortSignal,
): Promise<IntentResult> {
  const recent = conversation.messages.slice(-6);
  const historyText = recent
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const taskCtx = taskState?.currentTask
    ? `当前任务: ${taskState.currentTask.slice(0, 200)}`
    : '当前任务: 无';

  const sys: LlmMessage = {
    role: 'system',
    content: `判断用户输入的意图属于"qa"（仅查询/分析视频内容，无副作用）还是"tool"（需要剪辑/导出/处理视频，有副作用）。
输出严格 JSON：{"intent":"qa"|"tool","confidence":0.0~1.0,"reasoning":"原因"${taskState ? ',"taskAction":"continuation"|"correction"|"new_task"' : ''}}
${taskState ? 'taskAction 含义：continuation=延续当前任务，correction=纠正/调整当前任务，new_task=全新任务。' : ''}仅输出 JSON。`,
  };
  const user: LlmMessage = {
    role: 'user',
    content: `${taskCtx}\n近期对话:\n${historyText}\n\n用户输入: ${userInput}`,
  };

  try {
    // 不传 maxTokens：思考型模型的推理会占用大量 token，小限额会导致正文被截断、JSON 解析失败
    const raw = await caller([sys, user], { signal });
    const json = extractJson(raw);
    if (!json) return fallbackDefault(userInput);
    const intent: AgentIntent = json.intent === 'tool' ? 'tool' : 'qa';
    const confidence = clamp(Number(json.confidence) ?? 0.5, 0, 1);
    const taskAction = normalizeTaskAction(json.taskAction);
    return {
      intent,
      confidence,
      reasoning: typeof json.reasoning === 'string' ? json.reasoning : undefined,
      taskAction,
    };
  } catch {
    return fallbackDefault(userInput);
  }
}

function fallbackDefault(userInput: string): IntentResult {
  // 启发式兜底：仍尝试从关键词判断
  const rule = quickRuleMatch(userInput);
  if (rule) return { ...rule, taskAction: 'new_task' };
  return { intent: 'qa', confidence: 0.5, reasoning: 'LLM 分类失败，默认 qa', taskAction: 'new_task' };
}

/**
 * 任务路由：分类器返回明确 taskAction 用之；无进行中任务→new_task；启发式回退。
 */
export function routeTaskAction(
  intent: IntentResult,
  taskState: AgentTaskState | undefined,
  userInput: string,
): TaskRoute {
  if (intent.taskAction) return intent.taskAction;
  if (!taskState || !taskState.currentTaskId) return 'new_task';
  if (CONTINUATION_HINT.test(userInput)) return 'continuation';
  if (CORRECTION_HINT.test(userInput)) return 'correction';
  return 'new_task';
}

export async function classifyIntent(
  caller: LlmCaller,
  userInput: string,
  conversation: ConversationContext,
  taskState: AgentTaskState | undefined,
  signal?: AbortSignal,
): Promise<IntentResult> {
  const rule = quickRuleMatch(userInput);
  if (rule && rule.confidence >= 0.8) {
    if (taskState) {
      rule.taskAction = routeTaskAction(rule, taskState, userInput);
    }
    return rule;
  }
  const llm = await llmClassify(caller, userInput, conversation, taskState, signal);
  return llm;
}

// ── helpers ──

function extractJson(text: string): Record<string, unknown> | null {
  // 优先匹配 ```json 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeTaskAction(value: unknown): TaskRoute | undefined {
  if (value === 'continuation' || value === 'correction' || value === 'new_task') {
    return value;
  }
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
