import { message } from 'antd';
import {
  getPartSegmentEntries,
  normalizeSegmentComposeKind,
  getSegmentTimeRange,
  segmentKey,
  voiceKey,
  tryParseScriptParts,
  tryNormalizeScriptJsonTimestamps,
  extractJsonFromLlmText,
  parseTimeToMs,
  msToHmsMs,
  type ScriptPart,
  type ScriptSegment,
} from '../../types/script.js';
import {
  buildStructuredReportPromptText,
  buildPlotBreakdownPrompt,
  buildGoldenHookPromptText,
  buildSegmentPartPrompt,
  buildScriptPromptText,
  computeSegmentBudgetSeconds,
  SCRIPT_CONTINUATION_USER_TEXT,
  SRT_TRANSCRIBE_PROMPT,
  STRUCTURED_REPORT_MAX_TOKENS,
  PLOT_BREAKDOWN_MAX_TOKENS,
  SCRIPT_MAX_TOKENS_PER_ROUND,
  SCRIPT_MAX_CONTINUATION_ROUNDS,
  MAX_GOLDEN_HOOK_ZERO_START_RETRY_COUNT,
  MAX_SEGMENT_TIMESTAMP_RETRY_COUNT,
  SEGMENT_PARALLEL_LIMIT,
} from './step1Prompts.js';
import { resolveModelChatEndpoint } from '../../utils/modelChatEndpoint.js';
import type { ModelConfig } from '../../types/modelConfig.js';
import {
  setStructuredReport,
  setStep1Srt,
  setScript,
  setStreamingScriptText,
  setScriptGenerating,
  setCurrentStep,
} from '../../store/commentarySlice.js';
import type { store } from '../../store/index.js';

type AppStore = typeof store;

export async function streamChatCompletion(opts: {
  apiBase: string;
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
  enableThinking?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<{ text: string; finishReason?: string }> {
  const url = opts.apiBase.endsWith('/')
    ? opts.apiBase + 'chat/completions'
    : opts.apiBase + '/chat/completions';
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.enableThinking) {
    body.enable_thinking = true;
    body.thinking = { type: 'enabled' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${t.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('event-stream') || !res.body) {
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    opts.onDelta?.(text);
    return { text, finishReason: json?.choices?.[0]?.finish_reason };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  let finishReason: string | undefined;
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(':') || t === 'data: [DONE]') continue;
      if (!t.startsWith('data:')) continue;
      try {
        const json = JSON.parse(t.slice(5).trim());
        const delta =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.message?.content ??
          '';
        if (delta) {
          acc += delta;
          opts.onDelta?.(acc);
        }
        if (json?.choices?.[0]?.finish_reason) {
          finishReason = json.choices[0].finish_reason;
        }
      } catch {
        // ignore partial json
      }
    }
  }
  return { text: acc, finishReason };
}

async function callChatCompletionNonStream(opts: {
  apiBase: string;
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
  enableThinking?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const { text } = await streamChatCompletion(opts);
  return text.trim();
}

async function callModelTextContinuation(opts: {
  apiBase: string;
  apiKey: string;
  model: string;
  fullPromptText: string;
  enableThinking?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<string> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: opts.fullPromptText },
  ];
  let accumulated = '';
  for (let round = 0; round < SCRIPT_MAX_CONTINUATION_ROUNDS; round++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    const before = accumulated;
    const { text, finishReason } = await streamChatCompletion({
      apiBase: opts.apiBase,
      apiKey: opts.apiKey,
      model: opts.model,
      messages,
      maxTokens: SCRIPT_MAX_TOKENS_PER_ROUND,
      enableThinking: opts.enableThinking,
      signal: opts.signal,
      onDelta: (roundFull) => opts.onDelta?.(before + roundFull),
    });
    if (finishReason === 'content_filter' || finishReason === 'safety') {
      throw new Error('模型因安全策略未输出完整内容，请调整需求后重试');
    }
    accumulated = before + text;
    const truncated =
      finishReason === 'length' ||
      finishReason === 'max_tokens' ||
      (!finishReason && text.length >= SCRIPT_MAX_TOKENS_PER_ROUND * 0.9);
    if (!truncated) {
      break;
    }
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: SCRIPT_CONTINUATION_USER_TEXT });
    message.loading({ content: '脚本截断续写中…', key: 'vp-continuation', duration: 0 });
  }
  message.destroy('vp-continuation');
  return accumulated;
}

function parseTimeMs(v: string): number {
  return parseTimeToMs(v);
}

function maxTimeText(durationSec?: number | null): string {
  return msToHmsMs(Math.max(0, Math.floor((durationSec ?? 0) * 1000)));
}

function validateSegmentTimestamps(
  parts: ScriptPart[] | ScriptSegment[],
  totalDurationMs: number,
): string[] {
  const issues: string[] = [];
  const walk = (seg: ScriptSegment, path: string) => {
    const range = getSegmentTimeRange(seg);
    if (totalDurationMs > 0) {
      if (range.startMs < 0) issues.push(`${path} before_start ${range.startMs}`);
      if (range.endMs > totalDurationMs + 50) {
        issues.push(`${path} after_end ${range.endMs} > ${totalDurationMs}`);
      }
      if (range.endMs < range.startMs) issues.push(`${path} invalid end<start`);
    }
  };
  if (Array.isArray(parts) && parts.length && 'video_timestamp' in (parts[0] as ScriptSegment)) {
    (parts as ScriptSegment[]).forEach((s, i) => walk(s, `item[${i}]`));
    return issues.slice(0, 5);
  }
  (parts as ScriptPart[]).forEach((part, pi) => {
    getPartSegmentEntries(part).forEach((s, si) => walk(s, `part[${pi}].seg[${si}]`));
  });
  return issues.slice(0, 5);
}

async function callModelWithSegmentRetry(
  base: {
    apiBase: string;
    apiKey: string;
    model: string;
    fullPromptText: string;
    enableThinking?: boolean;
    signal?: AbortSignal;
    onDelta?: (t: string) => void;
  },
  segmentIndex: number,
  totalDurationMs: number,
): Promise<string> {
  let prompt = base.fullPromptText;
  for (let i = 0; i < MAX_SEGMENT_TIMESTAMP_RETRY_COUNT; i++) {
    if (base.signal?.aborted) throw new Error('cancelled');
    const raw = await callModelTextContinuation({ ...base, fullPromptText: prompt });
    const stripped = extractJsonFromLlmText(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const issues = validateSegmentTimestamps(parsed as ScriptPart[], totalDurationMs);
      if (!issues.length) return raw;
      prompt =
        base.fullPromptText +
        `\n\n注意：上次生成的第 ${segmentIndex} 段解说中存在超出原视频范围或无法解析的时间戳。原视频时间范围是 [00:00:00.000, ${maxTimeText(totalDurationMs / 1000)}]，请重新生成本段，确保所有 video_timestamp / start_time / end_time / timestamp 都在范围内。发现的问题：${issues.join('；')}。`;
      continue;
    }
    return raw;
  }
  throw new Error(`第 ${segmentIndex} 段脚本多次生成后仍有越界时间戳`);
}

export interface GenerateScriptDeps {
  store: AppStore;
  getState: () => ReturnType<AppStore['getState']>;
  modelConfig: ModelConfig | undefined;
  signal?: AbortSignal;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

function resolveEndpoint(modelRef: string, config: ModelConfig | undefined) {
  const ep = resolveModelChatEndpoint(modelRef, config);
  if (!ep?.apiKey) throw new Error(`未配置模型：${modelRef || '(空)'}，请先在设置中配置`);
  return ep;
}

/** JSON 数组转 SRT 文本 */
export function jsonTranscriptToSrt(jsonText: string): string {
  const raw = extractJsonFromLlmText(jsonText);
  let arr: Array<{ i?: number; t?: string; s?: string }>;
  try {
    arr = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!Array.isArray(arr)) return '';
  const toSrtTime = (s: string) => s.replace(/\./g, ',').replace(/-->/g, ' --> ');
  return arr
    .map((item, idx) => {
      const range = String(item.s || '').replace(/\s/g, '');
      const parts = range.split('-->');
      if (parts.length !== 2) return '';
      const start = parts[0].replace(/\./g, ',');
      const end = parts[1].replace(/\./g, ',');
      return `${idx + 1}\n${start} --> ${end}\n${item.t || ''}\n`;
    })
    .filter(Boolean)
    .join('\n');
}

export async function generateCommentaryScript(deps: GenerateScriptDeps): Promise<void> {
  const { store: st, modelConfig, signal } = deps;
  const state = st.getState().commentary;
  const inputPath = state.inputPath || state.localVideoPath;
  if (!inputPath) throw new Error('请先上传视频');
  if (!state.preparedId) throw new Error('缺少 preparedId：请先准备视频源');

  const identity = inputPath;
  const needReport =
    !state.structuredReport ||
    state.structuredReportSourceVideoLink !== identity;

  st.dispatch(setScriptGenerating({ running: true, progress: '准备中…' }));
  try {
    // 1) 结构化报告 + SRT
    if (needReport) {
      st.dispatch(setScriptGenerating({ running: true, progress: '上传媒体…' }));
      let uploadPath = inputPath;
      if (state.compressForUploadEnabled) {
        const dims: Record<string, { w: number; h: number }> = {
          '1080p': { w: 1920, h: 1080 },
          '720p': { w: 1280, h: 720 },
          '540p': { w: 960, h: 540 },
          '360p': { w: 640, h: 360 },
        };
        const d = dims[state.compressResolutionKey] || dims['360p'];
        const compressed = await window.viewPoint.compressVideoForUpload({
          inputPath,
          width: d.w,
          height: d.h,
          fps: state.compressFps,
          bitrateKbps: state.compressBitrateKbps,
        });
        uploadPath = compressed.outputPath;
      }
      const up = await window.viewPoint.uploadCommentaryMedia(uploadPath);
      if (!up.url) throw new Error(up.error || '视频上传失败（请配置对象存储）');
      const videoUrl = up.url;

      st.dispatch(setScriptGenerating({ running: true, progress: '生成 SRT…' }));
      const wav = await window.viewPoint.extractAudioToWav(inputPath);
      const audioUp = await window.viewPoint.uploadCommentaryMedia(wav.outputPath);
      let srtText = '';
      if (!audioUp.url) {
        throw new Error(audioUp.error || '音频上传失败，无法生成 SRT');
      }
      {
        const srtEp = resolveEndpoint(state.llmModels.step1SrtModel || state.llmModels.step1StructuredReportModel, modelConfig);
        const srtRaw = await streamChatCompletion({
          apiBase: srtEp.apiBase,
          apiKey: srtEp.apiKey,
          model: srtEp.modelName,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'input_audio', input_audio: { data: audioUp.url, format: 'wav' } },
                { type: 'text', text: SRT_TRANSCRIBE_PROMPT },
              ],
            },
          ],
          maxTokens: 20000,
          signal,
        });
        srtText = jsonTranscriptToSrt(srtRaw.text);
        if (!srtText) throw new Error('SRT 为空');
      }
      st.dispatch(setStep1Srt(srtText));

      st.dispatch(setScriptGenerating({ running: true, progress: '生成结构化报告…' }));
      const reportEp = resolveEndpoint(
        state.llmModels.step1StructuredReportModel || state.llmModels.step1SrtModel,
        modelConfig,
      );
      const reportPrompt = buildStructuredReportPromptText(state.localVideoDurationSeconds);

      const requestReportForUrl = async (url: string, durationSec: number) =>
        callChatCompletionNonStream({
          apiBase: reportEp.apiBase,
          apiKey: reportEp.apiKey,
          model: reportEp.modelName,
          maxTokens: STRUCTURED_REPORT_MAX_TOKENS,
          signal,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'video_url', video_url: { url } },
                {
                  type: 'text',
                  text: buildStructuredReportPromptText(durationSec),
                },
              ],
            },
          ],
        });

      let report = '';
      const totalSec = state.localVideoDurationSeconds || 0;
      if (totalSec > 600 && state.preparedId) {
        // 超过 600s：按 600 秒切分上传后并行拉片再合并
        const CHUNK = 600;
        const chunkCount = Math.ceil(totalSec / CHUNK);
        const chunkUrls: Array<{ url: string; startSec: number; endSec: number }> = [];
        for (let i = 0; i < chunkCount; i++) {
          const startMs = i * CHUNK * 1000;
          const endMs = Math.min(totalSec * 1000, (i + 1) * CHUNK * 1000);
          const clipped = await window.viewPoint.clipSegmentEx({
            preparedId: state.preparedId,
            partNumber: 0,
            segmentIndex: i,
            startMs,
            endMs,
            inputPath,
          });
          let clipUploadPath = clipped.outputPath;
          if (state.compressForUploadEnabled) {
            const compressed = await window.viewPoint.compressVideoForUpload({
              inputPath: clipped.outputPath,
              width: 640,
              height: 360,
              fps: state.compressFps,
              bitrateKbps: state.compressBitrateKbps,
            });
            clipUploadPath = compressed.outputPath;
          }
          const cu = await window.viewPoint.uploadCommentaryMedia(clipUploadPath);
          if (!cu.url) throw new Error(cu.error || `第 ${i + 1} 段上传失败`);
          chunkUrls.push({
            url: cu.url,
            startSec: i * CHUNK,
            endSec: Math.min(totalSec, (i + 1) * CHUNK),
          });
        }
        const chunkReports: string[] = new Array(chunkUrls.length);
        await mapLimit(chunkUrls, 2, async (chunk, idx) => {
          st.dispatch(
            setScriptGenerating({
              running: true,
              progress: `结构化报告 分段 ${idx + 1}/${chunkUrls.length}…`,
            }),
          );
          chunkReports[idx] = await requestReportForUrl(
            chunk.url,
            chunk.endSec - chunk.startSec,
          );
        });
        // 合并：保留表头一次，后续段跳过表头行
        const mergedLines: string[] = [];
        chunkReports.forEach((r, idx) => {
          const lines = r.split(/\r?\n/).filter((l) => l.trim());
          if (idx === 0) {
            mergedLines.push(...lines);
          } else {
            const body = lines.filter((l) => !/^时间段\|/.test(l.trim()));
            mergedLines.push(...body);
          }
        });
        report = mergedLines.join('\n');
      } else {
        report = await requestReportForUrl(videoUrl, totalSec);
      }
      if (!report.trim()) throw new Error('结构化报告为空');
      st.dispatch(setStructuredReport({ report: report.trim(), sourceLink: identity }));
    }

    const report = st.getState().commentary.structuredReport;
    const srtText = st.getState().commentary.step1SrtText;
    const voiceSpeed = st.getState().commentary.voiceSettings.speed || 1;
    const totalMs = Math.max(0, Math.floor((st.getState().commentary.localVideoDurationSeconds || 0) * 1000));

    // 2) 剧情拆解 + 抓眼钩子 并行
    st.dispatch(setScriptGenerating({ running: true, progress: '剧情拆解 / 抓眼钩子…' }));
    const plotEp = resolveEndpoint(state.llmModels.step1PlotBreakdownModel || state.llmModels.step1MainScriptModel, modelConfig);
    const hookEp = resolveEndpoint(state.llmModels.step1GoldenHookModel || state.llmModels.step1MainScriptModel, modelConfig);

    const plotPromise = callChatCompletionNonStream({
      apiBase: plotEp.apiBase,
      apiKey: plotEp.apiKey,
      model: plotEp.modelName,
      maxTokens: PLOT_BREAKDOWN_MAX_TOKENS,
      signal,
      messages: [{ role: 'user', content: buildPlotBreakdownPrompt(report, srtText) }],
    });

    const hookPromise = (async () => {
      let prompt = buildGoldenHookPromptText(report, voiceSpeed, srtText);
      for (let i = 0; i < MAX_GOLDEN_HOOK_ZERO_START_RETRY_COUNT; i++) {
        const raw = await callModelTextContinuation({
          apiBase: hookEp.apiBase,
          apiKey: hookEp.apiKey,
          model: hookEp.modelName,
          fullPromptText: prompt,
          signal,
        });
        try {
          const arr = JSON.parse(extractJsonFromLlmText(raw));
          const first = Array.isArray(arr) ? arr[0] : null;
          const start = first?.video_timestamp?.start;
          if (Array.isArray(arr) && arr.length && start && start !== '00:00:00.000') {
            return raw;
          }
          // 零起点或无法解析：带后缀重试
        } catch {
          // 解析失败也重试
        }
        prompt =
          buildGoldenHookPromptText(report, voiceSpeed, srtText) +
          '\n\n注意：上次生成的抓眼钩子第一段 video_timestamp.start 为 00:00:00.000，请确保使用原视频中真实的片段时间戳，不要从 00:00:00.000 开始。';
      }
      return callModelTextContinuation({
        apiBase: hookEp.apiBase,
        apiKey: hookEp.apiKey,
        model: hookEp.modelName,
        fullPromptText: prompt,
        signal,
      });
    })();

    const [plotRaw, hookRaw] = await Promise.all([plotPromise, hookPromise.catch(() => '')]);

    // parse plot
    let plot: { contentTitle: string; segments: Array<{ segment_index: number; title: string; summary: string; report_time_hint?: string }> } | null = null;
    try {
      const obj = JSON.parse(extractJsonFromLlmText(plotRaw));
      if (Array.isArray(obj?.plot_segments) && obj.plot_segments.length) {
        plot = {
          contentTitle: String(obj.content_title || ''),
          segments: obj.plot_segments,
        };
      }
    } catch {
      plot = null;
    }

    let parts: ScriptPart[] = [];
    if (plot) {
      st.dispatch(
        setScriptGenerating({
          running: true,
          progress: `分段生成脚本（${plot.segments.length} 段）…`,
        }),
      );
      const scriptEp = resolveEndpoint(state.llmModels.step1MainScriptModel, modelConfig);
      const n = plot.segments.length;
      const results: ScriptPart[] = new Array(n);
      await mapLimit(plot.segments, SEGMENT_PARALLEL_LIMIT, async (segment, idx) => {
        const i = idx + 1;
        const prompt = buildSegmentPartPrompt({
          totalVideoDurationSeconds: state.localVideoDurationSeconds,
          commentaryToOriginalRatio: {
            commentary: state.commentaryRatioCommentary,
            original: state.commentaryRatioOriginal,
          },
          commentaryMaxSeconds: state.commentaryMaxSeconds,
          voiceSpeed,
          mediaContentScope: state.mediaContentScope,
          structuredReport: report,
          srtText,
          plotAnalysisJson: plotRaw,
          segment,
          segmentIndex: i,
          totalSegments: n,
          segmentBudgetSeconds: computeSegmentBudgetSeconds(n, i),
          isLastSegment: i === n,
          plotContentTitle: plot!.contentTitle,
        });
        const raw = await callModelWithSegmentRetry(
          {
            apiBase: scriptEp.apiBase,
            apiKey: scriptEp.apiKey,
            model: scriptEp.modelName,
            fullPromptText: prompt,
            signal,
          },
          i,
          totalMs,
        );
        const parsed = tryParseScriptParts(extractJsonFromLlmText(raw));
        if (!parsed || parsed.length !== 1) throw new Error(`第 ${i} 段脚本解析失败`);
        results[idx] = parsed[0];
      });
      parts = results.filter(Boolean);
    } else {
      st.dispatch(setScriptGenerating({ running: true, progress: '单次生成脚本…' }));
      const scriptEp = resolveEndpoint(state.llmModels.step1MainScriptModel, modelConfig);
      const prompt = buildScriptPromptText({
        totalVideoDurationSeconds: state.localVideoDurationSeconds,
        commentaryToOriginalRatio: {
          commentary: state.commentaryRatioCommentary,
          original: state.commentaryRatioOriginal,
        },
        commentaryMaxSeconds: state.commentaryMaxSeconds,
        voiceSpeed,
        mediaContentScope: state.mediaContentScope,
        structuredReport: report,
        srtText,
      });
      const raw = await callModelTextContinuation({
        apiBase: scriptEp.apiBase,
        apiKey: scriptEp.apiKey,
        model: scriptEp.modelName,
        fullPromptText: prompt,
        signal,
        onDelta: (t) => st.dispatch(setStreamingScriptText(t)),
      });
      const parsed = tryParseScriptParts(extractJsonFromLlmText(raw));
      if (!parsed?.length) throw new Error('脚本 JSON 解析失败');
      parts = parsed;
    }

    // merge golden hook
    if (hookRaw) {
      try {
        let hookJson = extractJsonFromLlmText(hookRaw);
        const arr = JSON.parse(hookJson);
        if (Array.isArray(arr) && arr.length) {
          const looksWrapped = arr.every(
            (x: Record<string, unknown>) => x && typeof x === 'object' && 'golden_hook' in x,
          );
          if (looksWrapped) {
            for (const w of arr as Array<{ part_number?: number; golden_hook?: ScriptSegment[] }>) {
              const pn = Number(w.part_number || 1);
              const target = parts.find((p) => Number(p.part_number) === pn) || parts[0];
              if (target) {
                target.golden_hook = w.golden_hook || [];
              }
            }
          } else if (parts[0]) {
            parts[0].golden_hook = arr as ScriptSegment[];
          }
        }
      } catch {
        // hook merge optional
      }
    }

    parts = tryNormalizeScriptJsonTimestamps(parts);
    st.dispatch(setScript(parts));
    st.dispatch(setStreamingScriptText(''));
    st.dispatch(setCurrentStep(2));
    message.success('解说脚本生成完成');
  } finally {
    st.dispatch(setScriptGenerating({ running: false }));
  }
}

/** 并发工具 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  await mapLimit(items, concurrency, async (item) => {
    await worker(item);
  });
}

export { segmentKey, voiceKey, normalizeSegmentComposeKind, getSegmentTimeRange, getPartSegmentEntries };
