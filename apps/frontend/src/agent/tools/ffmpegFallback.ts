import type { AgentTool } from '../types.js';

const NETWORK_URL_RE = /^https?:\/\//i;

export interface FfmpegValidation {
  valid: boolean;
  error?: string;
}

/**
 * 安全校验：
 * - 禁止 -y（防止覆盖系统文件）
 * - 禁止网络 URL 作为输入/输出
 * - 输出路径必须限制在 outputBaseDir 下
 */
export function validateFfmpegCommand(
  args: string[],
  outputBaseDir: string,
): FfmpegValidation {
  if (!args || args.length === 0) {
    return { valid: false, error: 'ffmpeg 命令参数为空' };
  }
  if (args.includes('-y')) {
    return { valid: false, error: '禁止使用 -y 参数（防止覆盖文件）' };
  }
  // 找到输出路径：通常最后一个非选项参数，或 -i 之后的输出
  const outputCandidate = findOutputPath(args);
  if (outputCandidate) {
    if (NETWORK_URL_RE.test(outputCandidate)) {
      return { valid: false, error: '输出路径不得为网络 URL' };
    }
    if (!isWithinDir(outputCandidate, outputBaseDir)) {
      return { valid: false, error: `输出路径必须位于产物目录内: ${outputBaseDir}` };
    }
  }
  // 输入路径不得为网络 URL
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i' && i + 1 < args.length && NETWORK_URL_RE.test(args[i + 1])) {
      return { valid: false, error: '输入路径不得为网络 URL' };
    }
  }
  return { valid: true };
}

function findOutputPath(args: string[]): string | null {
  // 最后一个不以 - 开头且非已知选项值的参数视为输出
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a.startsWith('-')) continue;
    // 跳过 -i 的输入值
    if (i > 0 && args[i - 1] === '-i') continue;
    return a;
  }
  return null;
}

function isWithinDir(target: string, base: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = norm(target);
  const b = norm(base);
  return t === b || t.startsWith(b + '/');
}

export function createFfmpegFallbackTool(outputBaseDir: string): AgentTool {
  return {
    name: 'ffmpeg_execute',
    displayName: 'FFmpeg 执行',
    category: 'fallback',
    description:
      '执行任意 FFmpeg 命令（水印、调色、变速、转码等）。参数: args(字符串数组，ffmpeg 参数，不含 ffmpeg 本身)。输出文件必须位于产物目录。禁止 -y 与网络 URL。',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'ffmpeg 参数数组，如 ["-i","in.mp4","-vf","fps=30","out.mp4"]',
        },
      },
      required: ['args'],
    },
    handler: async (args) => {
      const cmdArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
      const validation = validateFfmpegCommand(cmdArgs, outputBaseDir);
      if (!validation.valid) {
        return JSON.stringify({ ok: false, error: validation.error });
      }
      const result = await window.viewPoint.ffmpegExecute({ args: cmdArgs });
      return JSON.stringify({
        ok: result.success,
        message: result.success ? 'FFmpeg 执行完成' : 'FFmpeg 执行失败',
        error: result.success ? undefined : result.stderr.slice(0, 300),
        content: {
          format: 'json',
          data: { exitCode: result.exitCode, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) },
        },
        outputPath: findOutputPath(cmdArgs) ?? undefined,
      });
    },
  };
}
