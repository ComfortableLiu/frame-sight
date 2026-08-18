import { describe, it, expect } from 'vitest';
import {
  extractSilenceSegments,
  extractSceneTimestamps,
  num,
  clampNum,
  srtTimeToMs,
  parseSrtCues,
} from './shared.js';

describe('extractSilenceSegments', () => {
  it('parses silence_start and silence_end pairs', () => {
    const stderr = `
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.7
[silencedetect @ 0x1] silence_start: 10.0
[silencedetect @ 0x1] silence_end: 12.5 | silence_duration: 2.5
`;
    const result = extractSilenceSegments(stderr);
    expect(result).toEqual([
      { start: 1.5, end: 3.2 },
      { start: 10.0, end: 12.5 },
    ]);
  });

  it('clamps negative start to 0', () => {
    const stderr = 'silence_start: -0.5\nsilence_end: 2.0';
    const result = extractSilenceSegments(stderr);
    expect(result[0].start).toBe(0);
  });

  it('filters out invalid segments where end <= start', () => {
    const stderr = 'silence_start: 5.0\nsilence_end: 3.0';
    const result = extractSilenceSegments(stderr);
    expect(result).toEqual([]);
  });

  it('returns empty for no silence', () => {
    expect(extractSilenceSegments('')).toEqual([]);
  });
});

describe('extractSceneTimestamps', () => {
  it('extracts pts_time values', () => {
    const stderr = `
[Parsed_showinfo_1 @ 0x1] pts_time:1.234
[Parsed_showinfo_1 @ 0x1] pts_time:5.678
`;
    expect(extractSceneTimestamps(stderr)).toEqual([1.234, 5.678]);
  });

  it('returns empty for no matches', () => {
    expect(extractSceneTimestamps('no timestamps here')).toEqual([]);
  });
});

describe('num', () => {
  it('returns value when valid', () => {
    expect(num({ a: 42 }, 'a', 0)).toBe(42);
  });

  it('returns fallback for missing key', () => {
    expect(num({}, 'a', 10)).toBe(10);
  });

  it('returns fallback for non-finite', () => {
    expect(num({ a: Infinity }, 'a', 10)).toBe(10);
    expect(num({ a: NaN }, 'a', 10)).toBe(10);
  });

  it('returns fallback for wrong type', () => {
    expect(num({ a: 'str' }, 'a', 10)).toBe(10);
  });
});

describe('clampNum', () => {
  it('clamps to range', () => {
    expect(clampNum({ v: 5 }, 'v', 3, 0, 10)).toBe(5);
    expect(clampNum({ v: -1 }, 'v', 3, 0, 10)).toBe(0);
    expect(clampNum({ v: 15 }, 'v', 3, 0, 10)).toBe(10);
  });
});

describe('srtTimeToMs', () => {
  it('converts SRT time to milliseconds', () => {
    expect(srtTimeToMs('00:01:30,500')).toBe(90500);
    expect(srtTimeToMs('01:00:00,000')).toBe(3600000);
  });

  it('handles dot separator', () => {
    expect(srtTimeToMs('00:00:05.123')).toBe(5123);
  });

  it('returns null for invalid format', () => {
    expect(srtTimeToMs('invalid')).toBeNull();
  });
});

describe('parseSrtCues', () => {
  it('parses standard SRT blocks', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,000
Second line`;
    const cues = parseSrtCues(srt);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3000, text: 'Hello world' },
      { startMs: 4000, endMs: 6000, text: 'Second line' },
    ]);
  });

  it('returns empty for undefined', () => {
    expect(parseSrtCues(undefined)).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(parseSrtCues('')).toEqual([]);
  });

  it('handles multi-line text', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Line one
Line two`;
    const cues = parseSrtCues(srt);
    expect(cues[0].text).toBe('Line one Line two');
  });
});
