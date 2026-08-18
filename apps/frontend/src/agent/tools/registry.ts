import type { AgentTool, ToolCallResult, ToolRuntimeDeps } from '../types.js';
import { createAnalysisTools } from './analysis.js';
import { createEditingTools } from './editing.js';
import { createFfmpegFallbackTool } from './ffmpegFallback.js';
import { createDynamicScriptTool } from './dynamicScript.js';
import { createSpeechTools } from './speech.js';

/**
 * 统一工具注册表：集中管理工具的注册、查询、注销与运行时动态注册。
 * 注册/注销后通过 onChange 通知订阅方（ReAct 循环借此刷新系统提示中的工具表）。
 */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private listeners = new Set<() => void>();

  /** 注册工具；重名抛错 */
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具已注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.notify();
  }

  /** 注销工具，返回是否存在 */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.notify();
    return removed;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 按注册顺序返回全部工具 */
  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** 订阅注册表变更，返回退订函数 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 从 create_dynamic_script_tool 的执行结果中解析工具描述并注册动态工具。
   * 结果不含工具描述或已注册同名工具时返回 null。
   */
  registerDynamicFromResult(result: ToolCallResult, runId: string): AgentTool | null {
    if (!result.success || !result.output) return null;
    let descriptor: Record<string, unknown> | null = null;
    try {
      const json = JSON.parse(result.output);
      const tool = json?.tool ?? null;
      if (tool && typeof tool.name === 'string' && tool.name) {
        descriptor = tool as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    if (!descriptor) return null;
    const name = descriptor.name as string;
    if (this.tools.has(name)) return null;

    const dynamicTool: AgentTool = {
      name,
      displayName: typeof descriptor.displayName === 'string' ? descriptor.displayName : name,
      category: 'dynamic',
      description:
        typeof descriptor.description === 'string' ? descriptor.description : '动态脚本工具',
      parameters:
        (descriptor.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      handler: async (args, _signal) => {
        const res = await window.viewPoint.agentScriptToolExecute({ name, args, runId });
        if (!res.success) throw new Error(res.error ?? '动态工具执行失败');
        return res.output;
      },
    };
    this.register(dynamicTool);
    return dynamicTool;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * 创建内置工具注册表：分析(5) + 编辑(4) + 语音合成(1) + ffmpeg 兜底(1) + 动态脚本(1)。
 */
export function createToolRegistry(deps: ToolRuntimeDeps): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    ...createAnalysisTools(deps),
    ...createEditingTools(deps),
    ...createSpeechTools(deps),
    createFfmpegFallbackTool(deps.outputBaseDir),
    createDynamicScriptTool(deps),
  ]) {
    registry.register(tool);
  }
  return registry;
}

/**
 * 兼容旧调用：返回全部内置工具的数组形式。
 */
export function createAllTools(deps: ToolRuntimeDeps): AgentTool[] {
  return createToolRegistry(deps).list();
}
