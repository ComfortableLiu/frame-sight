import { describe, expect, it } from 'vitest';
import {
  getPartSegmentEntries,
  normalizeSegmentComposeKind,
  getSegmentTimeRange,
  parseTimeToMs,
  segmentKey,
  voiceKey,
  tryParseScriptParts,
  type ScriptSegment,
} from '../types/script.js';
import { computeSegmentBudgetSeconds } from '../modules/commentary/step1Prompts.js';

describe('script types', () => {
  it('parseTimeToMs handles hh:mm:ss.mmm and mm:ss', () => {
    expect(parseTimeToMs('00:01:02.345')).toBe(62345);
    expect(parseTimeToMs('01:30')).toBe(90000);
    expect(parseTimeToMs(12.5)).toBe(12500);
  });

  it('segmentKey / voiceKey conventions', () => {
    expect(segmentKey(1, 2)).toBe('1-2');
    expect(voiceKey(1, 2)).toBe('1__2');
  });

  it('normalizeSegmentComposeKind maps aliases', () => {
    expect(normalizeSegmentComposeKind('commentary')).toBe('commentary');
    expect(normalizeSegmentComposeKind('解说')).toBe('commentary');
    expect(normalizeSegmentComposeKind('original_clip')).toBe('original_clip');
    expect(normalizeSegmentComposeKind('b-roll')).toBe('original_clip');
    expect(normalizeSegmentComposeKind('', { type: 'x', voiceover: '你好' } as ScriptSegment)).toBe('commentary');
  });

  it('getPartSegmentEntries flattens new structure', () => {
    const part = {
      part_number: 1,
      golden_hook: [{ type: 'original_clip', voiceover: null }],
      main_body: [{ type: 'commentary', voiceover: 'A' }],
      optional_ending: { type: 'commentary', voiceover: 'B' },
    };
    const entries = getPartSegmentEntries(part);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe('original_clip');
    expect(entries[2].voiceover).toBe('B');
  });

  it('getSegmentTimeRange prefers video_timestamp', () => {
    const range = getSegmentTimeRange({
      type: 'commentary',
      video_timestamp: { start: '00:00:10.000', end: '00:00:15.500' },
    });
    expect(range.startMs).toBe(10000);
    expect(range.endMs).toBe(15500);
  });

  it('tryParseScriptParts strips markdown fence', () => {
    const parts = tryParseScriptParts('```json\n[{"part_number":1}]\n```');
    expect(parts?.[0]?.part_number).toBe(1);
  });

  it('computeSegmentBudgetSeconds sums to 180', () => {
    const n = 5;
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += computeSegmentBudgetSeconds(n, i);
    expect(sum).toBe(180);
  });
});
