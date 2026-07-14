/**
 * 硬件测速与 LLM 实时吞吐估算。
 *
 * FFmpeg：执行一个固定小任务（probe 一段短视频），测量硬件处理速度。
 * LLM：在实际调用中通过 onDelta 回调实时测量 tokens/sec，无需额外 ping。
 */

export interface LlmThroughput {
  /** 实测输出 tokens/sec */
  tokensPerSec: number;
  /** 首 token 延迟（ms） */
  firstTokenMs: number;
}

/**
 * 包装 LlmCaller，在实际调用中测量吞吐量。
 * 返回的 caller 行为与原始完全一致，同时通过 onUsage 回调上报测量结果。
 */
export function createMeasuredCaller(
  originalCaller: import('./types.js').LlmCaller,
  onMeasured: (throughput: LlmThroughput) => void,
): import('./types.js').LlmCaller {
  return async (messages, options) => {
    const start = performance.now();
    let firstTokenMs = 0;
    let firstTokenRecorded = false;

    const wrappedOptions: import('./types.js').LlmCallOptions = {
      ...options,
      onDelta: (accumulated) => {
        if (!firstTokenRecorded && accumulated.length > 0) {
          firstTokenMs = performance.now() - start;
          firstTokenRecorded = true;
        }
        options?.onDelta?.(accumulated);
      },
      onUsage: (usage) => {
        options?.onUsage?.(usage);
        // 用 completionTokens / 总耗时 计算吞吐
        const totalMs = performance.now() - start;
        const outputTokens = usage.completionTokens || Math.max(1, Math.ceil(totalMs / 50));
        const tokensPerSec = totalMs > 0 ? (outputTokens / totalMs) * 1000 : 10;
        onMeasured({ tokensPerSec, firstTokenMs: firstTokenMs || totalMs * 0.3 });
      },
    };

    return originalCaller(messages, wrappedOptions);
  };
}

/**
 * FFmpeg 硬件测速：执行一个固定 probe 任务，测量处理速度。
 * 返回每秒可处理的视频时长（秒），用于估算实际 ffmpeg 任务耗时。
 */
export async function benchmarkFfmpeg(): Promise<number> {
  const start = performance.now();
  try {
    const result = await window.viewPoint.ffmpegExecute({
      args: [
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'null', '-',
      ],
    });
    if (!result?.success) {
      // ffmpeg 失败，返回默认实时速度
      return 1;
    }
    const elapsed = (performance.now() - start) / 1000;
    return Math.max(0.5, 2 / elapsed);
  } catch {
    return 1;
  }
}

/**
 * 根据 LLM 实测吞吐 + FFmpeg 硬件速度 + 视频参数，估算报告生成总耗时。
 */
export function estimateReportDuration(opts: {
  llmThroughput: LlmThroughput | null;
  ffmpegSpeed: number | null;
  durationSeconds: number | null;
}): {
  totalSec: number;
  segmentCount: number;
  llmCalls: number;
  breakdown: { phase: string; estimatedSec: number }[];
} {
  const segmentSeconds = 60;
  const duration = opts.durationSeconds ?? 120;
  const segmentCount = Math.max(1, Math.ceil(duration / segmentSeconds));

  // LLM 速度：用实测值，未测过时保守估 15 tokens/sec
  const tps = opts.llmThroughput?.tokensPerSec ?? 15;
  const firstTokenMs = opts.llmThroughput?.firstTokenMs ?? 1500;

  // 每次 LLM 调用额外固定开销
  const fixedOverheadMs = Math.max(300, firstTokenMs);

  // FFmpeg 速度：实测值，未测过时保守估 1x（实时）
  const ffmpegSpeed = opts.ffmpegSpeed ?? 1;

  // 各阶段预估输出 tokens
  const srtOutputTokens = 3000;
  const segmentOutputTokens = 1500;
  const mergeOutputTokens = 2000;

  const llmCallSec = (outputTokens: number) =>
    (fixedOverheadMs + (outputTokens / tps) * 1000) / 1000;

  // 音频提取 ≈ 视频时长 / ffmpeg 处理速度
  const audioExtractSec = Math.ceil(duration / ffmpegSpeed);
  const srtSec = Math.ceil(llmCallSec(srtOutputTokens));
  const segmentSec = Math.ceil(llmCallSec(segmentOutputTokens) * segmentCount);
  const mergeSec = Math.ceil(llmCallSec(mergeOutputTokens));
  const totalSec = audioExtractSec + srtSec + segmentSec + mergeSec;

  return {
    totalSec,
    segmentCount,
    llmCalls: 1 + segmentCount + 1,
    breakdown: [
      { phase: '提取音频', estimatedSec: audioExtractSec },
      { phase: 'SRT 转写', estimatedSec: srtSec },
      { phase: `分段分析（${segmentCount} 段）`, estimatedSec: segmentSec },
      { phase: '合并报告', estimatedSec: mergeSec },
    ],
  };
}

/**
 * 格式化秒数为人类可读字符串。
 */
export function formatDuration(sec: number): string {
  if (sec < 60) return `约 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) return `约 ${min} 分钟`;
  return `约 ${min} 分 ${rem} 秒`;
}
