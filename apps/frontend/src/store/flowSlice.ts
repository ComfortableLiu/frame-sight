import { createSlice, createSelector, type PayloadAction } from '@reduxjs/toolkit';
import type { AgentTaskState } from '../agent/types.js';
import type { DynamicScriptAudit } from '../agent/types.js';
import { INITIAL_AGENT_CHAT_MODEL } from '../utils/llmModels.js';
import { normalizeLlmModelId } from '../utils/modelChatEndpoint.js';

export interface LlmSettings {
  /** Agent 模型引用 platform::modelName，初值为空（无默认模型，用户必须配置） */
  agentChatModel: string;
}

export interface ToolCallResultSnapshot {
  success: boolean;
  output: string;
  error?: string;
  durationMs?: number;
  audit?: DynamicScriptAudit;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  thinking?: string;
  thinkingCollapsed?: boolean;
  /** 用户手动取消 */
  cancelled?: boolean;
  /** 中间步骤消息（轻量样式） */
  isStepMessage?: boolean;
  toolCallName?: string;
  toolCallArgs?: Record<string, unknown>;
  toolCallResult?: ToolCallResultSnapshot;
}

export interface AgentChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentChatMessage[];
  /** 产物目录名 */
  outputDir?: string;
  isRunning?: boolean;
  /** 关联视频路径快照 */
  videoPath?: string;
  /** 任务状态机 */
  taskState?: AgentTaskState;
}

export interface FlowState {
  llmSettings: LlmSettings;
  agentSessions: Record<string, AgentChatSession>;
  agentCurrentSessionId: string | null;
}

const initialState: FlowState = {
  llmSettings: {
    agentChatModel: INITIAL_AGENT_CHAT_MODEL,
  },
  agentSessions: {},
  agentCurrentSessionId: null,
};

const flowSlice = createSlice({
  name: 'flow',
  initialState,
  reducers: {
    setAgentCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.agentCurrentSessionId = action.payload;
    },
    upsertAgentSession(state, action: PayloadAction<AgentChatSession>) {
      const session = action.payload;
      session.updatedAt = Date.now();
      state.agentSessions[session.id] = session;
      if (!state.agentCurrentSessionId) {
        state.agentCurrentSessionId = session.id;
      }
    },
    setAgentSessionRunning(
      state,
      action: PayloadAction<{ sessionId: string; isRunning: boolean }>,
    ) {
      const session = state.agentSessions[action.payload.sessionId];
      if (session) {
        session.isRunning = action.payload.isRunning;
        session.updatedAt = Date.now();
      }
    },
    removeAgentSession(state, action: PayloadAction<string>) {
      delete state.agentSessions[action.payload];
      if (state.agentCurrentSessionId === action.payload) {
        const remaining = Object.values(state.agentSessions).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        state.agentCurrentSessionId = remaining[0]?.id ?? null;
      }
    },
    renameAgentSession(
      state,
      action: PayloadAction<{ sessionId: string; title: string }>,
    ) {
      const session = state.agentSessions[action.payload.sessionId];
      if (session) {
        session.title = action.payload.title;
        session.updatedAt = Date.now();
      }
    },
    setAgentChatModel(state, action: PayloadAction<string>) {
      state.llmSettings.agentChatModel = normalizeLlmModelId(action.payload);
    },
    restoreState(state, action: PayloadAction<FlowState>) {
      const incoming = action.payload;
      // 校验结构，损坏数据回退初始
      try {
        state.llmSettings =
          incoming?.llmSettings && typeof incoming.llmSettings === 'object'
            ? incoming.llmSettings
            : initialState.llmSettings;
        state.agentSessions =
          incoming?.agentSessions && typeof incoming.agentSessions === 'object' && !Array.isArray(incoming.agentSessions)
            ? incoming.agentSessions
            : {};
        state.agentCurrentSessionId =
          typeof incoming?.agentCurrentSessionId === 'string'
            ? incoming.agentCurrentSessionId
            : null;
      } catch {
        // 数据损坏，回退初始
        state.llmSettings = initialState.llmSettings;
        state.agentSessions = {};
        state.agentCurrentSessionId = null;
      }
    },
  },
});

export const {
  setAgentCurrentSessionId,
  upsertAgentSession,
  setAgentSessionRunning,
  removeAgentSession,
  renameAgentSession,
  setAgentChatModel,
  restoreState,
} = flowSlice.actions;

export default flowSlice.reducer;

/** 选择器：规范化后的 Agent 模型 ID，未配置返回空。 */
export const selectAgentChatModelId = (state: { flow: FlowState }): string => {
  return normalizeLlmModelId(state.flow.llmSettings.agentChatModel) ?? '';
};

/** 会话列表按 updatedAt 降序（memoized）。 */
export const selectAgentSessionsSorted = createSelector(
  (state: { flow: FlowState }) => state.flow.agentSessions,
  (sessions): AgentChatSession[] =>
    Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt),
);

export const selectCurrentAgentSession = createSelector(
  (state: { flow: FlowState }) => state.flow.agentCurrentSessionId,
  (state: { flow: FlowState }) => state.flow.agentSessions,
  (id, sessions): AgentChatSession | null => (id ? sessions[id] ?? null : null),
);

/**
 * 生成 outputDir：{yyyy-MM-dd}_agent_{random}。
 */
export function generateOutputDir(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${y}-${m}-${d}_agent_${rand}`;
}
