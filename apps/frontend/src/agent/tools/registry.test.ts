import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { AgentTool, ToolCallResult } from '../types.js';

function makeTool(name: string): AgentTool {
  return {
    name,
    displayName: name,
    category: 'analysis',
    description: `${name} 描述`,
    parameters: { type: 'object', properties: {} },
    handler: async () => JSON.stringify({ ok: true }),
  };
}

function makeDynamicResult(toolName: string): ToolCallResult {
  return {
    toolName: 'create_dynamic_script_tool',
    success: true,
    output: JSON.stringify({
      success: true,
      tool: {
        name: toolName,
        displayName: '动态工具',
        description: '测试动态工具',
        parameters: { type: 'object', properties: {} },
      },
    }),
  };
}

describe('ToolRegistry', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {
      viewPoint: {
        agentScriptToolExecute: vi.fn(async () => ({ success: true, output: '{"ok":true}' })),
      },
    };
  });

  it('register/get/has/list/size 基本行为', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a'));
    registry.register(makeTool('tool_b'));

    expect(registry.size).toBe(2);
    expect(registry.has('tool_a')).toBe(true);
    expect(registry.has('missing')).toBe(false);
    expect(registry.get('tool_b')?.name).toBe('tool_b');
    expect(registry.list().map((t) => t.name)).toEqual(['tool_a', 'tool_b']);
  });

  it('重名注册抛错', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a'));
    expect(() => registry.register(makeTool('tool_a'))).toThrow('工具已注册');
  });

  it('unregister 注销并返回是否存在', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a'));

    expect(registry.unregister('tool_a')).toBe(true);
    expect(registry.has('tool_a')).toBe(false);
    expect(registry.unregister('tool_a')).toBe(false);
  });

  it('onChange 在注册/注销时通知，退订后不再通知', () => {
    const registry = new ToolRegistry();
    const listener = vi.fn();
    const off = registry.onChange(listener);

    registry.register(makeTool('tool_a'));
    expect(listener).toHaveBeenCalledTimes(1);

    registry.unregister('tool_a');
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    registry.register(makeTool('tool_b'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('registerDynamicFromResult 注册动态工具并可执行', async () => {
    const registry = new ToolRegistry();
    const tool = registry.registerDynamicFromResult(makeDynamicResult('dynamic_echo'), 'run_1');

    expect(tool?.name).toBe('dynamic_echo');
    expect(registry.has('dynamic_echo')).toBe(true);
    expect(registry.get('dynamic_echo')?.category).toBe('dynamic');

    const output = await registry.get('dynamic_echo')!.handler({ text: 'hi' });
    expect(output).toBe('{"ok":true}');
    const execute = (globalThis as Record<string, unknown>).window as {
      viewPoint: { agentScriptToolExecute: ReturnType<typeof vi.fn> };
    };
    expect(execute.viewPoint.agentScriptToolExecute).toHaveBeenCalledWith({
      name: 'dynamic_echo',
      args: { text: 'hi' },
      runId: 'run_1',
    });
  });

  it('registerDynamicFromResult 对非法结果返回 null', () => {
    const registry = new ToolRegistry();

    expect(
      registry.registerDynamicFromResult(
        { toolName: 't', success: false, output: '' },
        'run_1',
      ),
    ).toBeNull();
    expect(
      registry.registerDynamicFromResult(
        { toolName: 't', success: true, output: 'not json' },
        'run_1',
      ),
    ).toBeNull();
    expect(
      registry.registerDynamicFromResult(
        { toolName: 't', success: true, output: '{"ok":true}' },
        'run_1',
      ),
    ).toBeNull();
    expect(registry.size).toBe(0);
  });

  it('registerDynamicFromResult 重名时不覆盖', () => {
    const registry = new ToolRegistry();
    registry.registerDynamicFromResult(makeDynamicResult('dynamic_echo'), 'run_1');
    const again = registry.registerDynamicFromResult(makeDynamicResult('dynamic_echo'), 'run_2');

    expect(again).toBeNull();
    expect(registry.size).toBe(1);
  });

  it('动态工具执行失败时抛出错误', async () => {
    (globalThis as Record<string, unknown>).window = {
      viewPoint: {
        agentScriptToolExecute: vi.fn(async () => ({ success: false, error: '沙箱错误' })),
      },
    };
    const registry = new ToolRegistry();
    registry.registerDynamicFromResult(makeDynamicResult('dynamic_fail'), 'run_1');

    await expect(registry.get('dynamic_fail')!.handler({})).rejects.toThrow('沙箱错误');
  });
});
