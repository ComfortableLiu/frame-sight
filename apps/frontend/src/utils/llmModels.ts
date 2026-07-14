/**
 * LLM 模型列表常量。
 *
 * 注意：Agent 模型无默认值。agentChatModel 初值为空，必须由用户在设置中配置。
 * 此文件仅提供常见平台元数据模板，供设置 UI 预填，不作为默认模型。
 */

export interface PlatformTemplate {
  /** 平台别名建议 */
  name: string;
  /** API base 建议 */
  apiBase: string;
  /** 是否支持思考模式 */
  supportsThinking: boolean;
}

export const PLATFORM_TEMPLATES: PlatformTemplate[] = [
  { name: 'bailian', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supportsThinking: true },
  { name: 'volcano', apiBase: 'https://ark.cn-beijing.volces.com/api/v3', supportsThinking: true },
  { name: 'openai', apiBase: 'https://api.openai.com/v1', supportsThinking: true },
];

/** Agent 默认最大补全 token。 */
export const DEFAULT_MAX_TOKENS = 8000;

/** 无默认 Agent 模型 —— agentChatModel 初值必须为空字符串。 */
export const INITIAL_AGENT_CHAT_MODEL = '';
