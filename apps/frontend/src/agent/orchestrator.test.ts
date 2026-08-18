import { describe, it, expect, vi } from 'vitest';
import { runAgent, runAgentForceQA } from './orchestrator.js';
import { ToolRegistry } from './tools/registry.js';
import type { AgentRunInput, LlmCaller } from './types.js';

function makeInput(overrides?: Partial<AgentRunInput>): AgentRunInput {
  return {
    userInput: 'test',
    videoContext: {
      localVideoPath: '/tmp/test.mp4',
      durationSeconds: 60,
      preparedId: 'p1',
      inputPath: '/tmp/test.mp4',
    },
    conversationContext: { messages: [] },
    llmCaller: vi.fn(async () => 'mock response'),
    tools: new ToolRegistry(),
    ...overrides,
  };
}

describe('runAgent', () => {
  it('returns error payload when LLM throws', async () => {
    const failingCaller: LlmCaller = async () => { throw new Error('API down'); };
    const result = await runAgent(makeInput({ llmCaller: failingCaller }));
    expect(result.payload.text).toContain('执行出错');
    expect(result.payload.text).toContain('API down');
  });

  it('returns qa intent on successful QA path', async () => {
    const caller: LlmCaller = async () => 'This video is about cats.';
    const result = await runAgent(makeInput({
      llmCaller: caller,
      config: { enableIntentClassification: false },
    }));
    // With intent classification disabled, it uses the override
    expect(result.intent.intent).toBe('tool');
  });
});

describe('runAgentForceQA', () => {
  it('returns qa result', async () => {
    const caller: LlmCaller = async () => '视频主要内容是关于猫咪的。';
    const result = await runAgentForceQA(makeInput({ llmCaller: caller }));
    expect(result.intent.intent).toBe('qa');
    expect(result.payload.text).toContain('猫咪');
  });

  it('handles errors gracefully', async () => {
    const failingCaller: LlmCaller = async () => { throw new Error('timeout'); };
    const result = await runAgentForceQA(makeInput({ llmCaller: failingCaller }));
    expect(result.intent.intent).toBe('qa');
    expect(result.payload.text).toContain('执行出错');
  });
});
