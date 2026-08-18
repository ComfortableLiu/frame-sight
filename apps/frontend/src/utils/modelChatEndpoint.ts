import type { LlmEndpoint } from '../agent/types.js';
import type { ModelConfig, ModelPlatform } from '../types/modelConfig.js';
import { DEFAULT_CONTEXT_WINDOW } from '../types/modelConfig.js';

const SEP = '::';

export interface ModelRef {
  platform: string;
  modelName: string;
}

/** 解析 `platform::modelName` 引用。 */
export function parseModelRef(ref: string): ModelRef | null {
  if (!ref || typeof ref !== 'string') return null;
  const idx = ref.indexOf(SEP);
  if (idx <= 0) return null;
  const platform = ref.slice(0, idx).trim();
  const modelName = ref.slice(idx + SEP.length).trim();
  if (!platform || !modelName) return null;
  return { platform, modelName };
}

/** 规范化模型引用（去空白、统一分隔）。 */
export function normalizeLlmModelId(ref: string): string {
  const parsed = parseModelRef(ref);
  if (!parsed) return '';
  return `${parsed.platform}${SEP}${parsed.modelName}`;
}

/** 按平台名（别名）查找平台。 */
export function findPlatform(config: ModelConfig | undefined, platformName: string): ModelPlatform | undefined {
  if (!config) return undefined;
  return config.platforms.find((p) => p.name === platformName);
}

/**
 * 解析模型引用为聊天端点：{apiBase, apiKey, platform, modelName, contextWindow}。
 */
export function resolveModelChatEndpoint(
  ref: string,
  config: ModelConfig | undefined,
): LlmEndpoint & { platform: string } | null {
  const parsed = parseModelRef(ref);
  if (!parsed) return null;
  const platform = findPlatform(config, parsed.platform);
  if (!platform) return null;
  // 优先读 modelSettings，回退旧字段 contextWindows（兼容旧数据）
  const contextWindow =
    platform.modelSettings?.[parsed.modelName]?.contextWindow ??
    platform.contextWindows?.[parsed.modelName];
  return {
    apiBase: platform.apiBase,
    apiKey: platform.apiKey,
    modelName: parsed.modelName,
    supportsThinking: true,
    contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
    platform: parsed.platform,
  };
}

/**
 * 取 Agent 模型的上下文窗口。未设置回退默认 200000（200k）。
 */
export function resolveAgentContextWindow(
  agentChatModel: string | undefined | null,
  config: ModelConfig | undefined,
): number {
  if (!agentChatModel) return DEFAULT_CONTEXT_WINDOW;
  const endpoint = resolveModelChatEndpoint(agentChatModel, config);
  return endpoint?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}
