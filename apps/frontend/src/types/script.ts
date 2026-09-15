/** 解说脚本数据结构与解析兼容层。 */

export interface ScriptTimestamp {
  start: string;
  end: string;
}

export interface ScriptSegment {
  type: 'commentary' | 'original_clip' | string;
  voiceover?: string | null;
  value_type?: string;
  voiceover_count?: number;
  calculated_duration?: number;
  video_timestamp?: ScriptTimestamp;
  start_time?: string;
  end_time?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ScriptPart {
  part_number: number | string;
  part_title?: string;
  content_title?: string;
  part_total_duration?: number;
  golden_hook?: ScriptSegment[] | Array<{ part_number: number; golden_hook: ScriptSegment[] }>;
  main_body?: ScriptSegment[];
  optional_ending?: ScriptSegment | ScriptSegment[] | null;
  scripts?: ScriptSegment[];
  segments?: ScriptSegment[];
  [key: string]: unknown;
}

export type SegmentComposeKind = 'commentary' | 'original_clip';

const COMMENTARY_ALIASES = new Set(['commentary', 'voiceover', 'narration', '解说']);
const CLIP_ALIASES = new Set([
  'original_clip',
  'originalclip',
  'original',
  'clip',
  '原片',
  'b_roll',
  'broll',
]);

export function padPartNum(n: number | string): string {
  return String(n).padStart(3, '0');
}

export function padSegNum(n: number): string {
  return String(n).padStart(3, '0');
}

export function segmentKey(partNumber: number | string, segmentIndex: number): string {
  return `${partNumber}-${segmentIndex}`;
}

export function voiceKey(partNumber: number | string, segmentIndex: number): string {
  return `${partNumber}__${segmentIndex}`;
}

export function formatSecondsToHmsMs(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frac).padStart(3, '0')}`;
}

/** 解析时间字符串/数字为毫秒。 */
export function parseTimeToMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000);
  if (typeof v !== 'string' || !v.trim()) return 0;
  const m = v.trim().match(/^(\d+):(\d+)(?::(\d+))?(?:\.(\d{1,3}))?$/);
  if (!m) return 0;
  const a = parseInt(m[1], 10) || 0;
  const b = parseInt(m[2], 10) || 0;
  const c = m[3] != null ? parseInt(m[3], 10) || 0 : 0;
  const frac = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  if (m[3] != null) {
    return a * 3600000 + b * 60000 + c * 1000 + frac;
  }
  return a * 60000 + b * 1000 + frac;
}

export function msToHmsMs(ms: number): string {
  return formatSecondsToHmsMs(ms / 1000);
}

export function normalizeSegmentComposeKind(raw: unknown, seg?: ScriptSegment): SegmentComposeKind {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (COMMENTARY_ALIASES.has(s)) return 'commentary';
  if (CLIP_ALIASES.has(s)) return 'original_clip';
  const vo = seg?.voiceover;
  return typeof vo === 'string' && vo.trim() ? 'commentary' : 'original_clip';
}

export function getSegmentTimeRange(seg: ScriptSegment): { startMs: number; endMs: number } {
  const vt = (seg.video_timestamp ?? (seg as { videoTimestamp?: ScriptTimestamp }).videoTimestamp) as
    | ScriptTimestamp
    | undefined;
  if (vt && (vt.start != null || vt.end != null)) {
    return {
      startMs: parseTimeToMs(vt.start),
      endMs: parseTimeToMs(vt.end),
    };
  }
  const st = seg.start_time ?? (seg as { startTime?: unknown }).startTime;
  const et = seg.end_time ?? (seg as { endTime?: unknown }).endTime;
  if (st != null || et != null) {
    return { startMs: parseTimeToMs(st), endMs: parseTimeToMs(et) };
  }
  if (seg.start != null || seg.end != null) {
    return { startMs: parseTimeToMs(seg.start), endMs: parseTimeToMs(seg.end) };
  }
  const ts = seg.timestamp;
  if (typeof ts === 'string') {
    const m = ts.match(
      /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~–—]\s*(\d{1,2}:\d{2}(?::\d{2})?)$/,
    );
    if (m) {
      return { startMs: parseTimeToMs(m[1]), endMs: parseTimeToMs(m[2]) };
    }
  }
  return { startMs: 0, endMs: 0 };
}

export function getPartSegmentEntries(part: ScriptPart): ScriptSegment[] {
  const isNew =
    Array.isArray(part.golden_hook) ||
    Array.isArray(part.main_body) ||
    part.optional_ending != null;
  if (isNew) {
    const out: ScriptSegment[] = [];
    const push = (v: unknown) => {
      if (!v) return;
      if (Array.isArray(v)) out.push(...(v as ScriptSegment[]));
      else out.push(v as ScriptSegment);
    };
    push(part.golden_hook);
    push(part.main_body);
    push(part.optional_ending);
    if (out.length > 0) return out;
  }
  if (Array.isArray(part.scripts)) return part.scripts;
  if (Array.isArray(part.segments)) return part.segments;
  return [];
}

export function stripMarkdownJsonFence(text: string): string {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

export function tryParseScriptParts(raw: string): ScriptPart[] | null {
  const text = stripMarkdownJsonFence(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as ScriptPart[];
  } catch {
    return null;
  }
  return null;
}

export function tryNormalizeScriptJsonTimestamps(parts: ScriptPart[]): ScriptPart[] {
  const normTs = (seg: ScriptSegment): ScriptSegment => {
    const range = getSegmentTimeRange(seg);
    return {
      ...seg,
      video_timestamp: {
        start: msToHmsMs(range.startMs),
        end: msToHmsMs(Math.max(range.startMs, range.endMs)),
      },
    };
  };
  return parts.map((p) => {
    const mapArr = (v: unknown): unknown => {
      if (!v) return v;
      if (Array.isArray(v)) return (v as ScriptSegment[]).map(normTs);
      return normTs(v as ScriptSegment);
    };
    const next: ScriptPart = { ...p };
    if (p.golden_hook != null) {
      if (Array.isArray(p.golden_hook) && p.golden_hook[0] && 'golden_hook' in (p.golden_hook[0] as object)) {
        next.golden_hook = (
          p.golden_hook as Array<{ part_number: number; golden_hook: ScriptSegment[] }>
        ).map((w) => ({ ...w, golden_hook: (w.golden_hook || []).map(normTs) }));
      } else {
        next.golden_hook = mapArr(p.golden_hook) as ScriptSegment[];
      }
    }
    if (p.main_body != null) next.main_body = mapArr(p.main_body) as ScriptSegment[];
    if (p.optional_ending != null) next.optional_ending = mapArr(p.optional_ending) as ScriptSegment[];
    if (p.scripts != null) next.scripts = mapArr(p.scripts) as ScriptSegment[];
    if (p.segments != null) next.segments = mapArr(p.segments) as ScriptSegment[];
    return next;
  });
}

/** 从 LLM 原文提取 JSON 对象/数组。 */
export function extractJsonFromLlmText(text: string): string {
  let s = stripMarkdownJsonFence(text);
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  if (objStart >= 0 && arrStart >= 0) start = Math.min(objStart, arrStart);
  else start = Math.max(objStart, arrStart);
  if (start < 0) return s;
  const isObj = s[start] === '{';
  const endChar = isObj ? '}' : ']';
  const end = s.lastIndexOf(endChar);
  if (end > start) return s.slice(start, end + 1);
  return s;
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = total % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frac).padStart(3, '0')}`;
}
