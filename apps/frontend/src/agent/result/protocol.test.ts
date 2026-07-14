import { describe, it, expect } from 'vitest';
import { serializeResultPayload, parseResultPayload, hasResultPayload } from './protocol.js';

describe('result protocol', () => {
  it('serializes and parses round-trip', () => {
    const payload = {
      text: '# 标题\n内容',
      mediaList: [{ title: 'v1', url: 'https://x/a.mp4', type: 'video' as const }],
      buttonList: [{ id: 'b1', label: '预览', action: 'preview' as const, mediaIndex: 0 }],
    };
    const serialized = serializeResultPayload(payload);
    expect(hasResultPayload(serialized)).toBe(true);
    const parsed = parseResultPayload(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('# 标题\n内容');
    expect(parsed!.mediaList).toHaveLength(1);
    expect(parsed!.mediaList![0].url).toBe('https://x/a.mp4');
  });

  it('parses nested fence', () => {
    const content = '前文\n```agent_result\n{"text":"hi"}\n```\n后文';
    expect(hasResultPayload(content)).toBe(true);
    const parsed = parseResultPayload(content);
    expect(parsed?.text).toBe('hi');
  });

  it('returns null for plain text without payload', () => {
    expect(hasResultPayload('只是普通文本')).toBe(false);
    expect(parseResultPayload('只是普通文本')).toBeNull();
  });

  it('uses last agent_result fence when multiple', () => {
    const content =
      '```agent_result\n{"text":"first"}\n```\n中间\n```agent_result\n{"text":"second"}\n```';
    expect(parseResultPayload(content)?.text).toBe('second');
  });
});
