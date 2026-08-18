import type { AgentTool, ToolRuntimeDeps } from '../types.js';
import {
  DANGEROUS_IDENTIFIERS,
  DYNAMIC_SCRIPT_LIMITS,
  PATH_ESCAPE_PATTERNS,
  type CreateDynamicScriptToolArgs,
  type DynamicScriptManifest,
  type DynamicToolDescriptor,
} from './dynamicTypes.js';

/**
 * 客户端侧预校验（与桌面端一致），减少无效 IPC 往返。
 */
export function validateDynamicManifest(manifest: DynamicScriptManifest): {
  valid: boolean;
  errors: string[];
  blockedRules: string[];
} {
  const errors: string[] = [];
  const blockedRules: string[] = [];

  if (!manifest.name.startsWith('dynamic_')) {
    errors.push('工具名必须以 dynamic_ 前缀开头');
  }
  if (!/^[a-z0-9_]+$/.test(manifest.name)) {
    errors.push('工具名须为 snake_case');
  }
  if (!/\b(main\s*(=|:)|function\s+main\s*\()/i.test(manifest.source)) {
    errors.push('源码必须包含 main 入口函数（function main(...) 或 const main = ...）');
  }
  if (manifest.source.length > DYNAMIC_SCRIPT_LIMITS.maxSourceChars) {
    errors.push(`源码超长（>${DYNAMIC_SCRIPT_LIMITS.maxSourceChars} 字符）`);
  }
  for (const id of DANGEROUS_IDENTIFIERS) {
    const re = new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`);
    if (re.test(manifest.source)) {
      blockedRules.push(id);
    }
  }
  for (const pat of PATH_ESCAPE_PATTERNS) {
    if (manifest.source.includes(pat)) {
      blockedRules.push(`路径逃逸: ${pat}`);
    }
  }

  return { valid: errors.length === 0 && blockedRules.length === 0, errors, blockedRules };
}

export function createDynamicScriptTool(deps: ToolRuntimeDeps): AgentTool {
  return {
    name: 'create_dynamic_script_tool',
    displayName: '创建临时脚本工具',
    category: 'dynamic',
    description:
      '当现有工具不满足需求时，创建临时 JS 脚本工具。脚本在 Node.js vm 沙箱中运行，入口 async function main(input, ctx)，ctx.files.writeText(name, content) 写入产物目录。参数: name(dynamic_ 前缀 snake_case)、displayName、description、parameters(JSON Schema)、source(JS 源码)。注册成功后该工具立即可被调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'dynamic_ 前缀，snake_case' },
        displayName: { type: 'string' },
        description: { type: 'string' },
        parameters: { type: 'object', description: 'JSON Schema' },
        source: { type: 'string', description: 'JS 源码，含 async function main(input, ctx)' },
      },
      required: ['name', 'source'],
    },
    handler: async (args) => {
      const manifest: DynamicScriptManifest = {
        name: String(args.name ?? ''),
        displayName: String(args.displayName ?? args.name ?? ''),
        description: String(args.description ?? ''),
        parameters:
          (args.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
        source: String(args.source ?? ''),
      };

      const local = validateDynamicManifest(manifest);
      if (!local.valid) {
        return JSON.stringify({
          success: false,
          error: '校验失败',
          errors: local.errors,
          blockedRules: local.blockedRules,
        });
      }

      // 注册到桌面端沙箱
      const reg = await window.viewPoint.agentScriptToolRegister({
        manifest,
        runId: deps.runId ?? '',
      });
      if (!reg.success || !reg.tool) {
        return JSON.stringify({ success: false, error: reg.error ?? '注册失败' });
      }

      const tool: DynamicToolDescriptor = reg.tool;
      return JSON.stringify({
        success: true,
        tool,
        message: `动态工具 ${tool.name} 已注册，可在后续轮次调用`,
      });
    },
  };
}

export type { CreateDynamicScriptToolArgs };
