import * as vm from 'node:vm';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface DynamicScriptManifest {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  source: string;
}

export interface DynamicScriptValidationResult {
  valid: boolean;
  errors: string[];
  blockedRules: string[];
}

export interface RegisteredTool {
  manifest: DynamicScriptManifest;
  script: vm.Script;
  outputDir: string;
}

export interface DynamicToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DynamicScriptExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  audit?: {
    outputFiles: string[];
    durationMs: number;
  };
}

const LIMITS = {
  maxTimeoutMs: 30_000,
  maxSourceChars: 16_384,
  maxResultBytes: 65_536,
  maxOutputFiles: 10,
};

const DANGEROUS_IDENTIFIERS = [
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

const PATH_ESCAPE_PATTERNS = ['../', '/etc', '/usr', '~/'];

export class AgentScriptToolService {
  /** runId → toolName → RegisteredTool */
  private registry = new Map<string, Map<string, RegisteredTool>>();
  private activeExecutions = new Map<string, AbortController>();
  private outputBaseDir: string;

  constructor(outputBaseDir: string) {
    this.outputBaseDir = outputBaseDir;
  }

  validate(manifest: DynamicScriptManifest): DynamicScriptValidationResult {
    const errors: string[] = [];
    const blockedRules: string[] = [];

    if (!manifest.name.startsWith('dynamic_')) {
      errors.push('工具名必须以 dynamic_ 前缀开头');
    }
    if (!/^[a-z0-9_]+$/.test(manifest.name)) {
      errors.push('工具名须为 snake_case');
    }
    const src = manifest.source ?? '';
    if (
      !/\bfunction\s+main\s*\(/.test(src) &&
      !/async\s+function\s+main\s*\(/.test(src)
    ) {
      errors.push('源码必须包含 function main(input, ctx) 入口');
    }
    if (src.length > LIMITS.maxSourceChars) {
      errors.push(`源码超长（>${LIMITS.maxSourceChars} 字符）`);
    }
    for (const id of DANGEROUS_IDENTIFIERS) {
      const re = new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`);
      if (re.test(src)) blockedRules.push(id);
    }
    for (const pat of PATH_ESCAPE_PATTERNS) {
      if (src.includes(pat)) blockedRules.push(`路径逃逸: ${pat}`);
    }

    return {
      valid: errors.length === 0 && blockedRules.length === 0,
      errors,
      blockedRules,
    };
  }

  register(
    manifest: DynamicScriptManifest,
    runId: string,
  ): { success: boolean; error?: string; tool?: DynamicToolDescriptor } {
    const validation = this.validate(manifest);
    if (!validation.valid) {
      return {
        success: false,
        error: `校验失败: ${[...validation.errors, ...validation.blockedRules].join('; ')}`,
      };
    }
    let script: vm.Script;
    try {
      script = new vm.Script(manifest.source, { filename: `${manifest.name}.js` });
    } catch (err) {
      return { success: false, error: `编译失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const runMap = this.registry.get(runId) ?? new Map<string, RegisteredTool>();
    const outputDir = path.join(this.outputBaseDir, runId, manifest.name);
    fs.mkdirSync(outputDir, { recursive: true });
    runMap.set(manifest.name, { manifest, script, outputDir });
    this.registry.set(runId, runMap);
    return {
      success: true,
      tool: {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        parameters: manifest.parameters,
      },
    };
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    runId: string,
    signal?: AbortSignal,
  ): Promise<DynamicScriptExecutionResult> {
    const runMap = this.registry.get(runId);
    const tool = runMap?.get(name);
    if (!tool) {
      return { success: false, output: '', error: `未注册工具: ${name}` };
    }
    const execId = randomUUID();
    const controller = new AbortController();
    this.activeExecutions.set(execId, controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    const start = Date.now();
    const outputFiles: string[] = [];
    const ctx = buildSandboxContext(tool.outputDir, outputFiles);

    const timeout = new Promise<DynamicScriptExecutionResult>((resolve) => {
      const timer = setTimeout(
        () => resolve({ success: false, output: '', error: '执行超时' }),
        LIMITS.maxTimeoutMs,
      );
      timer.unref?.();
    });

    const run = (async (): Promise<DynamicScriptExecutionResult> => {
      try {
        const sandbox = { ...ctx, args, main: undefined as unknown };
        vm.createContext(sandbox);
        tool.script.runInContext(sandbox as vm.Context);
        const mainFn = (sandbox as { main?: (...a: unknown[]) => unknown }).main;
        if (typeof mainFn !== 'function') {
          return { success: false, output: '', error: '未找到 main 入口函数' };
        }
        const result = await Promise.resolve(mainFn(args, ctx.api));
        const json = JSON.stringify(result ?? { ok: true });
        if (Buffer.byteLength(json, 'utf8') > LIMITS.maxResultBytes) {
          return { success: false, output: '', error: '结果超限' };
        }
        return {
          success: true,
          output: json,
          audit: { outputFiles: outputFiles.slice(0, LIMITS.maxOutputFiles), durationMs: Date.now() - start },
        };
      } catch (err) {
        return {
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          audit: { outputFiles, durationMs: Date.now() - start },
        };
      }
    })();

    const result = await Promise.race([run, timeout]);
    signal?.removeEventListener('abort', onAbort);
    this.activeExecutions.delete(execId);
    return result;
  }

  cleanupRun(runId: string): void {
    this.registry.delete(runId);
  }

  getRegisteredTools(runId: string): DynamicToolDescriptor[] {
    const runMap = this.registry.get(runId);
    if (!runMap) return [];
    return Array.from(runMap.values()).map((t) => ({
      name: t.manifest.name,
      displayName: t.manifest.displayName,
      description: t.manifest.description,
      parameters: t.manifest.parameters,
    }));
  }
}

interface SandboxContext {
  api: {
    files: {
      writeText: (name: string, content: string) => string;
      listOutputs: () => string[];
    };
  };
  JSON: typeof JSON;
  console: { log: (...a: unknown[]) => void };
  Math: typeof Math;
  args: unknown;
}

function buildSandboxContext(outputDir: string, outputFiles: string[]): SandboxContext {
  return {
    api: {
      files: {
        writeText(name: string, content: string): string {
          const safe = name.replace(/[\\/]/g, '_');
          const abs = path.join(outputDir, safe);
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          outputFiles.push(abs);
          return abs;
        },
        listOutputs(): string[] {
          return [...outputFiles];
        },
      },
    },
    JSON,
    console: { log: () => {} },
    Math,
    args: undefined,
  };
}
