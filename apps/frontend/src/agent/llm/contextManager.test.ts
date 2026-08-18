import { describe, it, expect } from 'vitest';
import {
  deriveContextLimit,
  estimateMessagesTokens,
  estimateOccupancy,
  truncateMessages,
  filterThinkingFromMessages,
  ensureContextWithinLimit,
} from './contextManager.js';
import type { LlmMessage } from '../types.js';

describe('deriveContextLimit', () => {
  it('uses explicit maxContextTokens when provided', () => {
    expect(deriveContextLimit(undefined, 50000)).toBe(50000);
  });

  it('derives from endpoint contextWindow', () => {
    const endpoint = { contextWindow: 128000 } as never;
    // 128000 - 8000 (completion) - 8192 (overhead) = 111808
    expect(deriveContextLimit(endpoint)).toBe(111808);
  });

  it('falls back to default 200000 when no endpoint', () => {
    // 200000 - 8000 - 8192 = 183808
    expect(deriveContextLimit(undefined)).toBe(183808);
  });

  it('respects custom maxTokens', () => {
    const endpoint = { contextWindow: 128000 } as never;
    expect(deriveContextLimit(endpoint, undefined, 4000)).toBe(128000 - 4000 - 8192);
  });

  it('enforces minimum 8000', () => {
    const endpoint = { contextWindow: 1000 } as never;
    expect(deriveContextLimit(endpoint)).toBe(8000);
  });
});

describe('estimateMessagesTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('estimates tokens for mixed content', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: '你好世界' }, // 4 CJK chars ≈ 6 tokens
      { role: 'assistant', content: 'hello' }, // 5 chars ≈ 2 tokens
    ];
    const tokens = estimateMessagesTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('estimateOccupancy', () => {
  it('uses full estimate when no usage baseline', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: 'test' }];
    const result = estimateOccupancy(msgs, null, 0);
    expect(result).toBe(estimateMessagesTokens(msgs));
  });

  it('uses usage baseline + incremental estimate', () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    // baseline says first 2 messages used 100 tokens, 3rd message is incremental
    const result = estimateOccupancy(msgs, 100, 2);
    expect(result).toBe(100 + estimateMessagesTokens([msgs[2]]));
  });
});

describe('filterThinkingFromMessages', () => {
  it('removes closed thinking tags', () => {
    const msgs: LlmMessage[] = [
      { role: 'assistant', content: 'before <thinking>internal</thinking> after' },
    ];
    const result = filterThinkingFromMessages(msgs);
    expect(result[0].content).toBe('before  after');
  });

  it('removes unclosed thinking tags', () => {
    const msgs: LlmMessage[] = [
      { role: 'assistant', content: 'before <thinking>internal stuff' },
    ];
    const result = filterThinkingFromMessages(msgs);
    expect(result[0].content).toBe('before');
  });

  it('handles multiple thinking blocks', () => {
    const msgs: LlmMessage[] = [
      { role: 'assistant', content: 'a <thinking>x</thinking> b <thinking>y</thinking> c' },
    ];
    const result = filterThinkingFromMessages(msgs);
    expect(result[0].content).toBe('a  b  c');
  });

  it('does not modify messages without thinking tags', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: 'hello' }];
    const result = filterThinkingFromMessages(msgs);
    expect(result[0].content).toBe('hello');
  });
});

describe('truncateMessages', () => {
  it('keeps short messages unchanged', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: 'short' }];
    const result = truncateMessages(msgs);
    expect(result[0].content).toBe('short');
  });

  it('truncates very long messages', () => {
    const longContent = 'x'.repeat(100000);
    const msgs: LlmMessage[] = [{ role: 'user', content: longContent }];
    const result = truncateMessages(msgs);
    expect(result[0].content.length).toBeLessThan(longContent.length);
    expect(result[0].content).toContain('已截断');
  });
});

describe('ensureContextWithinLimit', () => {
  const mockCaller = async () => 'summary of conversation';

  it('returns messages unchanged when under limit', async () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'hello' },
    ];
    const result = await ensureContextWithinLimit(mockCaller, msgs, {
      limit: 1000000,
      lastUsagePromptTokens: null,
      usageBaselineMessageCount: 0,
    });
    expect(result.length).toBe(2);
  });

  it('compresses when over limit', async () => {
    const bigContent = 'x'.repeat(50000);
    const msgs: LlmMessage[] = [
      { role: 'system', content: bigContent },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'q5' },
      { role: 'assistant', content: 'a5' },
      { role: 'user', content: 'q6' },
      { role: 'assistant', content: 'a6' },
      { role: 'user', content: 'q7' },
    ];
    const result = await ensureContextWithinLimit(mockCaller, msgs, {
      limit: 1000,
      lastUsagePromptTokens: null,
      usageBaselineMessageCount: 0,
    });
    // Should have compressed: summary + recent turns
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0].content).toContain('历史摘要');
  });
});
