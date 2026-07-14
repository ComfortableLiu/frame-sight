import { describe, it, expect } from 'vitest';
import { estimateTokens } from './caller.js';
import { deriveContextLimit } from './contextManager.js';

describe('estimateTokens', () => {
  it('estimates CJK at ~1.5 tokens/char', () => {
    const text = '你好世界'; // 4 CJK
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(5);
    expect(tokens).toBeLessThanOrEqual(7);
  });

  it('estimates ascii at ~0.25 tokens/char', () => {
    const text = 'abcdefgh'; // 8 ascii
    const tokens = estimateTokens(text);
    expect(tokens).toBe(2);
  });

  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('deriveContextLimit', () => {
  it('derives from contextWindow', () => {
    const endpoint = { apiBase: '', apiKey: '', modelName: '', supportsThinking: false, contextWindow: 128000 };
    const limit = deriveContextLimit(endpoint, undefined, 8000);
    expect(limit).toBe(128000 - 8000 - 8192);
  });

  it('falls back to default 200000 when contextWindow missing', () => {
    const endpoint = { apiBase: '', apiKey: '', modelName: '', supportsThinking: false };
    const limit = deriveContextLimit(endpoint, undefined, 8000);
    expect(limit).toBe(200000 - 8000 - 8192);
  });

  it('uses explicit maxContextTokens when provided', () => {
    const endpoint = { apiBase: '', apiKey: '', modelName: '', supportsThinking: false, contextWindow: 128000 };
    const limit = deriveContextLimit(endpoint, 50000, 8000);
    expect(limit).toBe(50000);
  });
});
