import type { AgentTool } from '../types.js';

/** 动态脚本 manifest（前端构造，传给桌面端沙箱）。 */
export interface DynamicScriptManifest {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  source: string;
}

/** 校验结果。 */
export interface DynamicScriptValidationResult {
  valid: boolean;
  errors: string[];
  blockedRules: string[];
}

/** 注册成功后返回的工具描述符。 */
export interface DynamicToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 配额限制（与桌面端 AgentScriptToolService 一致）。 */
export const DYNAMIC_SCRIPT_LIMITS = {
  maxTimeoutMs: 30_000,
  maxSourceChars: 16_384,
  maxResultBytes: 65_536,
  maxOutputFiles: 10,
} as const;

/** 危险标识符列表（与桌面端静态扫描一致）。 */
export const DANGEROUS_IDENTIFIERS = [
  'process',
  'require',
  'import',
  'eval',
  'Function',
  'child_process',
  'spawn',
  'exec',
  'fs',
  'rm',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'globalThis',
  'global',
];

export const PATH_ESCAPE_PATTERNS = ['../', '/etc', '/usr', '~/'];

export interface CreateDynamicScriptToolArgs {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  source: string;
}

export type DynamicScriptToolResult = {
  success: boolean;
  tool?: DynamicToolDescriptor;
  error?: string;
};

export type { AgentTool };
