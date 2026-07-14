import type { LlmCallOptions, LlmCaller, LlmEndpoint, LlmMessage, LlmUsage } from '../types.js';

/** 默认请求超时（5 分钟），防永久挂起 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 本地 token 估算（仅兜底）。
 * 中文 ≈ 1.5 tokens/字符，英文/数字 ≈ 0.25 tokens/字符。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

function buildBody(endpoint: LlmEndpoint, messages: LlmMessage[], options?: LlmCallOptions) {
  const body: Record<string, unknown> = {
    model: endpoint.modelName,
    messages,
    max_tokens: options?.maxTokens ?? 8000,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (endpoint.supportsThinking && options?.enableThinking) {
    body.enable_thinking = true;
  }
  return body;
}

function extractErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.error?.message) return `LLM ${status}: ${parsed.error.message}`;
    if (parsed?.message) return `LLM ${status}: ${parsed.message}`;
  } catch {
    // 非 JSON
  }
  return `LLM ${status}: ${bodyText.slice(0, 200)}`;
}

/**
 * 合并外部 signal 与内部超时 signal。
 */
function mergeSignals(external?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): AbortSignal | undefined {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  timer.unref?.();

  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  }
  // 清理 timer 在 abort 时
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/**
 * 统一流式 + 非流式调用。
 */
export async function callLlmOnce(
  endpoint: LlmEndpoint,
  messages: LlmMessage[],
  options?: LlmCallOptions,
): Promise<string> {
  const body = buildBody(endpoint, messages, options);
  const url = joinUrl(endpoint.apiBase, '/chat/completions');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: mergeSignals(options?.signal),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('LLM 请求被取消或超时');
    }
    throw new Error(`LLM 网络请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(extractErrorMessage(res.status, text));
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
    return parseStream(res, options);
  }

  // 非流式回退
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 响应非 JSON: ${text.slice(0, 200)}`);
  }
  reportUsage((data as { usage?: unknown })?.usage, options);
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : content ? JSON.stringify(content) : '';
  if (text) options?.onDelta?.(text);
  return text;
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}

function reportUsage(usage: unknown, options?: LlmCallOptions): void {
  if (!usage || typeof usage !== 'object' || !options?.onUsage) return;
  const u = usage as Record<string, number>;
  const promptTokens = u.prompt_tokens ?? u.promptTokens ?? 0;
  const completionTokens = u.completion_tokens ?? u.completionTokens ?? 0;
  const totalTokens = u.total_tokens ?? u.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens > 0 || totalTokens > 0) {
    options.onUsage({ promptTokens, completionTokens, totalTokens } satisfies LlmUsage);
  }
}

async function parseStream(res: Response, options?: LlmCallOptions): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('LLM 流式响应无 body');
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let parseFailCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          parseFailCount = 0;
          if (chunk?.usage) reportUsage(chunk.usage, options);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            options?.onDelta?.(accumulated);
          }
        } catch {
          parseFailCount++;
          // 连续 10 次解析失败视为流损坏
          if (parseFailCount > 10) {
            throw new Error('LLM 流式响应连续解析失败，可能已损坏');
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // 中断时返回已积累的内容（部分结果优于崩溃）
      if (accumulated) return accumulated;
      throw new Error('LLM 流式请求被取消或超时');
    }
    // 网络中断：返回已积累内容
    if (accumulated) {
      console.warn('LLM 流式中断，返回部分结果:', err);
      return accumulated;
    }
    throw new Error(`LLM 流式读取失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (!accumulated) {
    // 流正常结束但无内容
    console.warn('LLM 流式响应为空');
  }
  return accumulated;
}

/**
 * 工厂：返回绑定端点的 LlmCaller。
 */
export function createLlmCaller(endpoint: LlmEndpoint): LlmCaller {
  return (messages, options) => callLlmOnce(endpoint, messages, options);
}
