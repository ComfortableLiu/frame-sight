import type { AgentTool, ToolRuntimeDeps } from '../types.js';
import { createAnalysisTools } from './analysis.js';
import { createEditingTools } from './editing.js';
import { createFfmpegFallbackTool } from './ffmpegFallback.js';
import { createDynamicScriptTool } from './dynamicScript.js';

/**
 * 创建全部工具：分析(5) + 编辑(4) + ffmpeg 兜底(1) + 动态脚本(1)。
 */
export function createAllTools(deps: ToolRuntimeDeps): AgentTool[] {
  return [
    ...createAnalysisTools(deps),
    ...createEditingTools(deps),
    createFfmpegFallbackTool(deps.outputBaseDir),
    createDynamicScriptTool(deps),
  ];
}
