import type {
  AgentRunConfig,
  AgentRunInput,
  AgentRunOutput,
  AgentTaskState,
  IntentResult,
  ResultPayload,
} from './types.js';
import { classifyIntent, routeTaskAction } from './intent/classifier.js';
import {
  applyTaskAction,
  createInitialTaskState,
  summarizeTaskResult,
} from './taskStateMachine.js';
import { runReActLoop } from './react/loop.js';
import { respondToQuestion } from './qa/responder.js';
import {
  buildQAResultPayload,
  buildToolResultPayload,
} from './result/builder.js';
import { ensureContextWithinLimit, deriveContextLimit } from './llm/contextManager.js';

const DEFAULT_CONFIG: Required<
  Pick<
    AgentRunConfig,
    'maxToolSteps' | 'enableFinalSummary' | 'enableIntentClassification' | 'enableTaskStateMachine'
  >
> = {
  maxToolSteps: 12,
  enableFinalSummary: true,
  enableIntentClassification: true,
  enableTaskStateMachine: true,
};

export async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const config = resolveConfig(input.config);
  const callbacks = input.callbacks;
  try {
    callbacks?.onStageChange?.({ kind: 'classifying_intent' });

    // 任务状态机初始化
    let taskState: AgentTaskState = config.enableTaskStateMachine
      ? input.taskState ?? createInitialTaskState()
      : createInitialTaskState();

    // 意图识别
    let intent: IntentResult;
    if (!config.enableIntentClassification) {
      intent = { intent: 'tool', confidence: 1, reasoning: '禁用意图分类，强制工具分支' };
    } else {
      intent = await classifyIntent(
        input.llmCaller,
        input.userInput,
        input.conversationContext,
        config.enableTaskStateMachine ? taskState : undefined,
        input.signal,
      );
    }

    // 任务路由
    if (config.enableTaskStateMachine && intent.intent === 'tool') {
      const action = routeTaskAction(intent, taskState, input.userInput);
      taskState = applyTaskAction(taskState, action, input.userInput);
    } else if (config.enableTaskStateMachine && !taskState.currentTaskId) {
      // QA 分支但无当前任务，也建立任务记录
      taskState = applyTaskAction(taskState, 'new_task', input.userInput);
    }

    if (intent.intent === 'qa') {
      callbacks?.onStageChange?.({ kind: 'qa_responding' });
      // 启动时上下文压缩
      const limit = deriveContextLimit(input.endpoint, input.config?.maxContextTokens);
      const compressed = await ensureContextWithinLimit(
        input.llmCaller,
        conversationToLlm(input),
        {
          limit,
          lastUsagePromptTokens: null,
          usageBaselineMessageCount: 0,
          signal: input.signal,
        },
      );
      const answer = await respondToQuestion(
        input.llmCaller,
        input.userInput,
        input.videoContext,
        lmToConversation(compressed),
        input.signal,
      );
      const payload = buildQAResultPayload(answer, input.videoContext);
      callbacks?.onStageChange?.({ kind: 'building_result' });
      callbacks?.onStageChange?.({ kind: 'done' });
      return {
        intent,
        payload,
        updatedTaskState: config.enableTaskStateMachine ? taskState : undefined,
      };
    }

    // 工具分支
    callbacks?.onStageChange?.({ kind: 'react_planning' });
    const reactOutput = await runReActLoop({
      userInput: input.userInput,
      videoContext: input.videoContext,
      conversationContext: input.conversationContext,
      llmCaller: input.llmCaller,
      tools: input.tools,
      taskState: config.enableTaskStateMachine ? taskState : undefined,
      config: input.config,
      callbacks: input.callbacks,
      endpoint: input.endpoint,
      signal: input.signal,
      maxTokens: 8000,
      runId: input.tools.find((t) => t.category === 'dynamic')?.name,
    });

    // 任务摘要
    if (config.enableTaskStateMachine) {
      const summary = summarizeTaskResult(reactOutput.finalAnswer, reactOutput.steps.map((s) => s.result));
      taskState = { ...taskState, currentTaskResult: summary };
    }

    callbacks?.onStageChange?.({ kind: 'building_result' });
    const payload = buildToolResultPayload(reactOutput.finalAnswer, reactOutput.steps.map((s) => s.result));
    callbacks?.onStageChange?.({ kind: 'done' });

    return {
      intent,
      reactOutput,
      payload,
      updatedTaskState: config.enableTaskStateMachine ? taskState : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    callbacks?.onStageChange?.({ kind: 'error', message });
    const errorPayload: ResultPayload = {
      text: `⚠️ 执行出错：${message}`,
    };
    return {
      intent: { intent: 'qa', confidence: 0, reasoning: '异常兜底' },
      payload: errorPayload,
      updatedTaskState: input.taskState,
    };
  }
}

export function runAgentForceTool(input: AgentRunInput): Promise<AgentRunOutput> {
  return runAgent({ ...input, config: { ...input.config, enableIntentClassification: false } });
}

export function runAgentForceQA(input: AgentRunInput): Promise<AgentRunOutput> {
  // 强制 QA：注入一个明确 qa 的意图入口
  const qaInput: AgentRunInput = {
    ...input,
    config: { ...input.config, enableIntentClassification: false },
  };
  return runAgentForceQAImpl(qaInput);
}

async function runAgentForceQAImpl(input: AgentRunInput): Promise<AgentRunOutput> {
  const callbacks = input.callbacks;
  try {
    callbacks?.onStageChange?.({ kind: 'qa_responding' });
    const answer = await respondToQuestion(
      input.llmCaller,
      input.userInput,
      input.videoContext,
      input.conversationContext,
      input.signal,
    );
    const payload = buildQAResultPayload(answer, input.videoContext);
    callbacks?.onStageChange?.({ kind: 'done' });
    return {
      intent: { intent: 'qa', confidence: 1, reasoning: '强制 QA' },
      payload,
      updatedTaskState: input.taskState,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    callbacks?.onStageChange?.({ kind: 'error', message });
    return {
      intent: { intent: 'qa', confidence: 0, reasoning: '异常' },
      payload: { text: `⚠️ 执行出错：${message}` },
      updatedTaskState: input.taskState,
    };
  }
}

function resolveConfig(config?: AgentRunConfig) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    maxContextTokens: config?.maxContextTokens,
  };
}

function conversationToLlm(input: AgentRunInput) {
  return input.conversationContext.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

function lmToConversation(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): import('./types.js').ConversationContext {
  return {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
}
