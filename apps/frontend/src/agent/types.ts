/**
 * Agent 模式核心类型定义。
 * 所有 Agent 引擎模块共享的类型集中于此。
 */

// ───────────────────────── 意图识别 ─────────────────────────

export type AgentIntent = 'qa' | 'tool';

export type TaskRoute = 'continuation' | 'correction' | 'new_task';

export interface IntentResult {
  intent: AgentIntent;
  /** 0~1 */
  confidence: number;
  reasoning?: string;
  taskAction?: TaskRoute;
}

// ───────────────────────── 工具协议 ─────────────────────────

export type ToolCategory = 'analysis' | 'editing' | 'fallback' | 'dynamic';

export interface AgentTool {
  /** 蛇形命名，如 get_video_info */
  name: string;
  /** 中文显示名 */
  displayName: string;
  category: ToolCategory;
  /** 给 LLM 理解的详细描述 */
  description: string;
  /** JSON Schema 风格 */
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface DynamicScriptAudit {
  runId?: string;
  toolName: string;
  blockedRules?: string[];
  outputFiles?: string[];
  durationMs?: number;
}

export interface ToolCallResult {
  toolName: string;
  success: boolean;
  /** JSON 字符串 */
  output: string;
  error?: string;
  durationMs?: number;
  /** 关联任务纪元 */
  epoch?: number;
  audit?: DynamicScriptAudit;
}

// ───────────────────────── TODO 驱动循环 ─────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  id: string;
  description: string;
  toolHint?: string;
  status: TodoStatus;
  attempts: number;
  lastError?: string;
}

export interface ParsedAgentResponse {
  toolCall: ToolCall | null;
  doneSignal: { todoId?: string } | null;
  todosAdded: TodoItem[] | null;
  todosUpdated: Array<Partial<TodoItem> & { id: string }> | null;
  initialTodos: TodoItem[] | null;
  rawText: string;
}

// ───────────────────────── 视频上下文 ─────────────────────────

export interface VideoContext {
  localVideoPath: string;
  durationSeconds: number | null;
  /** 全片拉片报告 */
  structuredReport?: string;
  /** SRT 字幕 */
  srtText?: string;
  preparedId: string;
  inputPath: string;
}

// ───────────────────────── 结果协议 ─────────────────────────

export interface MediaItem {
  title: string;
  url: string;
  type: 'video' | 'audio' | 'image' | 'gif';
  fromTool?: string;
  /** 缩略图 URL（可选） */
  thumbnailUrl?: string;
}

export interface ResultButton {
  id: string;
  label: string;
  action: 'preview' | 'download' | 'open';
  mediaIndex?: number;
  url?: string;
  /** 自定义打开目标（仅 open 动作，如 'view-report' / 'view-srt'） */
  openTarget?: string;
}

export interface ResultPayload {
  /** Markdown 回答 */
  text: string;
  /** 视频预览数据源 */
  mediaList?: MediaItem[];
  buttonList?: ResultButton[];
}

// ── 工具返回协议（结构化报告格式规范） ──

/** 工具处理器返回的 JSON 字符串解析后的结构。 */
export interface ToolReturnPayload {
  ok: boolean;
  title?: string;
  description?: string;
  /** 结构化内容体 */
  content?: ToolStructuredContent;
  /** 状态消息 */
  message?: string;
  /** 仅失败时的错误原因 */
  error?: string;
  /** 媒体文件 URL */
  wosUrl?: string;
  /** 备选媒体 URL */
  finalUrl?: string;
  /** SRT 字幕文本（仅 transcribe_audio） */
  srt?: string;
  /** 兼容旧字段 */
  success?: boolean;
  objectUrl?: string;
  outputPath?: string;
  [key: string]: unknown;
}

/** 结构化内容体：按 format 选择 UI 渲染方式。 */
export type ToolStructuredContent =
  | { format: 'mermaid'; code: string }
  | { format: 'json_subtitles'; entries: Array<{ i: number; p: string; t: string; y: string; q?: string; w?: string; s?: string }> }
  | { format: 'scenes'; scenes: Array<{ index: number; startMs: number; endMs: number; durationMs: number }>; totalScenes?: number; totalDurationMs?: number }
  | { format: 'silence'; silences: Array<{ startMs: number; endMs: number; durationMs: number }>; totalSilenceMs?: number }
  | { format: 'search_results'; keyword: string; matchCount: number; results: Array<{ matchIndex: number; start: string; end: string; before: string; match: string; after: string }> }
  | { format: 'markdown'; text: string }
  | { format: 'json'; data: unknown };

// ───────────────────────── 任务状态机 ─────────────────────────

export interface TaskSummary {
  taskId: string;
  description: string;
  /** 一句话摘要 */
  result: string;
  epoch: number;
  completedAt: number;
}

export interface AgentTaskState {
  currentTask: string;
  currentTaskId: string;
  currentTaskResult?: string;
  epoch: number;
  finishedTasks: TaskSummary[];
  interruptedTasks: TaskSummary[];
}

// ───────────────────────── LLM 调用 ─────────────────────────

/** 多模态消息内容块：文本或视频（对应 chat/completions 的 content 数组形式）。 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'input_video'; input_video: { data: string } }
  | { type: 'video_url'; video_url: { url: string }; fps?: number; media_resolution?: string };

/**
 * LLM 消息。裸写 LlmMessage 时 content 为纯文本字符串（现有用法不受影响）；
 * 需要多模态（视频+文本）时使用 LlmMessage<string | LlmContentPart[]>，
 * content 数组会原样 POST 给 chat/completions（caller.ts 不做加工）。
 */
export interface LlmMessage<C extends string | LlmContentPart[] = string> {
  role: 'system' | 'user' | 'assistant';
  content: C;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmEndpoint {
  apiBase: string;
  apiKey: string;
  modelName: string;
  supportsThinking: boolean;
  /** 用户设置的该模型上下文窗口大小（token）。undefined 表示未设置，回退默认 200000。 */
  contextWindow?: number;
}

export interface LlmCallOptions {
  signal?: AbortSignal;
  /** 默认 8000 */
  maxTokens?: number;
  enableThinking?: boolean;
  onDelta?: (text: string) => void;
  /** 上报真实 token 用量，作为上下文计量主依据 */
  onUsage?: (usage: LlmUsage) => void;
}

export type LlmCaller = (messages: LlmMessage[], options?: LlmCallOptions) => Promise<string>;

// ───────────────────────── 对话上下文 ─────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ConversationContext {
  messages: ConversationMessage[];
}

// ───────────────────────── ReAct 循环 ─────────────────────────

export interface ReActStep {
  stepIndex: number;
  toolName: string;
  toolDisplayName: string;
  args: Record<string, unknown>;
  result: ToolCallResult;
}

export interface ReActLoopOutput {
  todos: TodoItem[];
  steps: ReActStep[];
  finalAnswer: string;
  truncated: boolean;
}

// ───────────────────────── 顶层 API ─────────────────────────

export type AgentStage =
  | { kind: 'idle' }
  | { kind: 'classifying_intent' }
  | { kind: 'qa_responding' }
  | { kind: 'react_planning' }
  | {
      kind: 'react_executing';
      stepIndex: number;
      toolName: string;
      toolDisplayName: string;
      planTotalSteps?: number;
    }
  | { kind: 'react_finalizing' }
  | { kind: 'building_result' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export interface AgentRunConfig {
  /** 默认 12 */
  maxToolSteps?: number;
  /** 压缩阈值。未传时由模型 contextWindow 派生（contextWindow - maxTokens - 8192）。 */
  maxContextTokens?: number;
  /** 默认 true */
  enableFinalSummary?: boolean;
  /** 默认 true */
  enableIntentClassification?: boolean;
  /** 默认 true */
  enableTaskStateMachine?: boolean;
}

export interface AgentRunCallbacks {
  onStageChange?: (stage: AgentStage) => void;
  onReActStep?: (step: ReActStep) => void;
  onLlmDelta?: (accumulated: string) => void;
  onTodosReady?: (todos: TodoItem[]) => void;
  onTodoUpdate?: (todos: TodoItem[], changedIds: string[]) => void;
}

export interface ToolRuntimeDeps {
  videoPath: string;
  preparedId: string;
  inputPath: string;
  outputBaseDir: string;
  durationSeconds: number | null;
  srtText?: string;
  uploadToObjectStorage: (filePath: string) => Promise<{ objectUrl: string }>;
  generateSrt: (videoPath: string, signal?: AbortSignal) => Promise<string>;
  /** 用于动态脚本工具隔离 */
  runId?: string;
}

export interface AgentRunInput {
  userInput: string;
  videoContext: VideoContext;
  conversationContext: ConversationContext;
  llmCaller: LlmCaller;
  /** 统一工具注册表（含运行时动态注册的工具） */
  tools: import('./tools/registry.js').ToolRegistry;
  endpoint?: LlmEndpoint;
  signal?: AbortSignal;
  config?: AgentRunConfig;
  callbacks?: AgentRunCallbacks;
  taskState?: AgentTaskState;
  /** 动态脚本工具按 run 隔离 */
  runId?: string;
}

export interface AgentRunOutput {
  intent: IntentResult;
  reactOutput?: ReActLoopOutput;
  payload: ResultPayload;
  updatedTaskState?: AgentTaskState;
}
