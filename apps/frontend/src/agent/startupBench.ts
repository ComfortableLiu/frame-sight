/**
 * 应用启动时的硬件与网络测速。
 *
 * 跑一次小任务（FFmpeg 2s 测试视频 + LLM "回复 OK"），
 * 结果存 localStorage，后续报告生成直接复用，无需每次重测。
 *
 * 用户看到"测速完成"提示后可正常关闭应用。
 */

import type { LlmCaller, LlmEndpoint } from './types.js';

const STORAGE_KEY = 'frame-sight:startup-bench';

export interface StartupBenchResult {
  /** FFmpeg 处理速度（视频秒/实际秒） */
  ffmpegSpeed: number;
  /** LLM 首 token 延迟（ms） */
  llmFirstTokenMs: number;
  /** LLM 输出 tokens/sec */
  llmTokensPerSec: number;
  /** 测速时间戳 */
  timestamp: number;
}

/**
 * 从 localStorage 读取上次测速结果（24h 内有效）。
 */
export function loadSavedBench(): StartupBenchResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StartupBenchResult;
    // 24h 过期
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

function saveBench(result: StartupBenchResult): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    // ignore
  }
}

/**
 * 执行启动测速。并行跑 FFmpeg 和 LLM，完成后保存结果。
 * 返回测速结果 + 人类可读描述。
 */
export async function runStartupBench(
  createCaller: (endpoint: LlmEndpoint) => LlmCaller,
  endpoint: LlmEndpoint | null,
): Promise<{ result: StartupBenchResult; description: string }> {
  const [ffmpegResult, llmResult] = await Promise.allSettled([
    benchFfmpeg(),
    endpoint ? benchLlm(createCaller(endpoint)) : Promise.resolve(null),
  ]);

  const ffmpegSpeed = ffmpegResult.status === 'fulfilled' ? ffmpegResult.value : 1;
  const llm = llmResult.status === 'fulfilled' ? llmResult.value : null;

  const result: StartupBenchResult = {
    ffmpegSpeed,
    llmFirstTokenMs: llm?.firstTokenMs ?? 1500,
    llmTokensPerSec: llm?.tokensPerSec ?? 15,
    timestamp: Date.now(),
  };

  saveBench(result);

  const description = [
    `硬件处理速度：${ffmpegSpeed.toFixed(1)}x`,
    llm
      ? `模型响应：首 token ${Math.round(result.llmFirstTokenMs)}ms，吞吐 ${Math.round(result.llmTokensPerSec)} tok/s`
      : '模型响应：未配置模型，使用默认值',
  ].join(' | ');

  return { result, description };
}

async function benchFfmpeg(): Promise<number> {
  const start = performance.now();
  const result = await window.viewPoint.ffmpegExecute({
    args: ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-f', 'null', '-'],
  });
  if (!result?.success) {
    throw new Error('ffmpeg 测速失败');
  }
  const elapsed = (performance.now() - start) / 1000;
  return Math.max(0.5, 2 / elapsed);
}

async function benchLlm(caller: LlmCaller): Promise<{ firstTokenMs: number; tokensPerSec: number }> {
  const start = performance.now();
  let firstTokenMs = 0;
  let recorded = false;

  let text: string;
  try {
    text = await caller([{ role: 'user', content: '回复 OK' }], {
      maxTokens: 10,
      onDelta: (acc) => {
        if (!recorded && acc.length > 0) {
          firstTokenMs = performance.now() - start;
          recorded = true;
        }
      },
    });
  } catch (err) {
    throw new Error(`LLM 测速失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const totalMs = performance.now() - start;
  const outputTokens = Math.max(1, Math.ceil(text.length * 1.2));
  const tokensPerSec = totalMs > 0 ? (outputTokens / totalMs) * 1000 : 10;

  return { firstTokenMs: firstTokenMs || totalMs * 0.3, tokensPerSec };
}
