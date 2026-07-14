import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface FfmpegExecuteArgs {
  args: string[];
  cwd?: string;
  /** 超时毫秒，默认 10 分钟 */
  timeoutMs?: number;
  /** stderr/stdout 最大累积字符，防止 OOM */
  maxBufferChars?: number;
}

export interface FfmpegExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outputPath?: string;
  timedOut?: boolean;
}

export interface VideoInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  codec: string | null;
  container: string | null;
  fileSizeBytes: number | null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_CHARS = 2 * 1024 * 1024; // 2MB 文本

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

export class VideoService {
  async executeFfmpeg(args: FfmpegExecuteArgs): Promise<FfmpegExecuteResult> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuf = args.maxBufferChars ?? MAX_BUFFER_CHARS;

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(ffmpegBin(), args.args, { cwd: args.cwd });
      } catch (err) {
        resolve({
          success: false,
          stdout: '',
          stderr: `ffmpeg 启动失败: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: null,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timedOut = false;

      const finish = (result: Omit<FfmpegExecuteResult, 'outputPath'>) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        const output = findOutput(args.args);
        resolve({ ...result, outputPath: output });
      };

      const onStderr = (d: Buffer) => {
        if (stderr.length < maxBuf) stderr += d.toString();
      };
      const onStdout = (d: Buffer) => {
        if (stdout.length < maxBuf) stdout += d.toString();
      };

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      // 管道错误（背压/fd 不足）
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});

      child.on('close', (code) => {
        finish({ success: code === 0 && !timedOut, stdout, stderr, exitCode: code, timedOut });
      });
      child.on('error', (err) => {
        finish({ success: false, stdout, stderr: err.message, exitCode: null, timedOut });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish({ success: false, stdout, stderr: stderr + '\n[ffmpeg 超时被终止]', exitCode: null, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async getMediaDuration(filePath: string): Promise<number | null> {
    const res = await this.executeFfmpeg({
      args: ['-i', filePath, '-f', 'null', '-'],
    });
    const m = res.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (!m) return null;
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }

  async probeVideoQuality(filePath: string): Promise<VideoInfo> {
    const res = await this.executeFfmpeg({ args: ['-i', filePath, '-f', 'null', '-'] });
    const stderr = res.stderr;
    const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    const size = stderr.match(/Stream.*Video.*,?\s(\d+)x(\d+)/);
    const fps = stderr.match(/(\d+\.?\d*)\s*fps/);
    const codec = stderr.match(/Stream.*Video:\s*(\w+)/);
    const container = path.extname(filePath).slice(1) || null;
    let fileSizeBytes: number | null = null;
    try {
      fileSizeBytes = fs.statSync(filePath).size;
    } catch {
      // ignore
    }
    return {
      durationSeconds: duration
        ? parseInt(duration[1]) * 3600 + parseInt(duration[2]) * 60 + parseFloat(duration[3])
        : null,
      width: size ? parseInt(size[1]) : null,
      height: size ? parseInt(size[2]) : null,
      frameRate: fps ? parseFloat(fps[1]) : null,
      codec: codec ? codec[1] : null,
      container,
      fileSizeBytes,
    };
  }

  async statFile(filePath: string): Promise<{ size: number | null; exists: boolean }> {
    try {
      const stat = fs.statSync(filePath);
      return { size: stat.size, exists: true };
    } catch {
      return { size: null, exists: false };
    }
  }

  async extractAudioFromVideo(inputPath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    const outDir = path.dirname(inputPath);
    const outputPath = path.join(outDir, `audio_${Date.now()}.mp3`);
    const res = await this.executeFfmpeg({
      args: ['-i', inputPath, '-vn', '-acodec', 'libmp3lame', outputPath],
    });
    return { success: res.success, outputPath: res.success ? outputPath : undefined, error: res.success ? undefined : res.stderr.slice(0, 300) };
  }

  async prepareSource(source: { filePath: string }): Promise<{
    preparedId: string;
    inputPath: string;
    durationSeconds: number | null;
  }> {
    // 转码为可预览 mp4（若已是 mp4 则直接用）
    const ext = path.extname(source.filePath).toLowerCase();
    const preparedId = `prep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (ext === '.mp4') {
      const duration = await this.getMediaDuration(source.filePath);
      return { preparedId, inputPath: source.filePath, durationSeconds: duration };
    }
    const outputPath = path.join(path.dirname(source.filePath), `${preparedId}.mp4`);
    const res = await this.executeFfmpeg({
      args: ['-i', source.filePath, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', outputPath],
    });
    if (!res.success) {
      throw new Error(`转码失败: ${res.stderr.slice(0, 300)}`);
    }
    const duration = await this.getMediaDuration(outputPath);
    return { preparedId, inputPath: outputPath, durationSeconds: duration };
  }

  async clipSegment(args: {
    inputPath: string;
    startMs: number;
    endMs: number;
    outputPath: string;
    originalClipVolume?: number;
  }): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    // 输入校验
    if (!args.inputPath || !args.outputPath) {
      return { success: false, error: 'inputPath/outputPath 不能为空' };
    }
    if (typeof args.startMs !== 'number' || typeof args.endMs !== 'number') {
      return { success: false, error: 'startMs/endMs 必须为数字' };
    }
    if (args.startMs < 0 || args.endMs <= args.startMs) {
      return { success: false, error: `时间区间无效: startMs=${args.startMs}, endMs=${args.endMs}` };
    }
    const volume = args.originalClipVolume ?? 1;
    const res = await this.executeFfmpeg({
      args: [
        '-i', args.inputPath,
        '-ss', (args.startMs / 1000).toString(),
        '-to', (args.endMs / 1000).toString(),
        '-c:v', 'libx264', '-preset', 'fast',
        '-c:a', 'aac',
        '-af', `volume=${volume}`,
        args.outputPath,
      ],
    });
    return {
      success: res.success,
      outputPath: res.success ? args.outputPath : undefined,
      error: res.success ? undefined : res.stderr.slice(0, 300),
    };
  }

  async composePartVideo(args: {
    segments: Array<{ clipPath: string; startMs: number; endMs: number }>;
    outputPath: string;
  }): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    if (!args.segments || args.segments.length === 0) {
      return { success: false, error: 'segments 为空' };
    }
    if (!args.outputPath) {
      return { success: false, error: 'outputPath 不能为空' };
    }
    // concat demuxer
    const listPath = path.join(path.dirname(args.outputPath), `concat_${Date.now()}.txt`);
    const list = args.segments.map((s) => `file '${s.clipPath.replace(/'/g, "'\\''")}'`).join('\n');
    let res: FfmpegExecuteResult;
    try {
      fs.writeFileSync(listPath, list, 'utf8');
      res = await this.executeFfmpeg({
        args: ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', args.outputPath],
      });
    } finally {
      try {
        fs.unlinkSync(listPath);
      } catch {
        // ignore
      }
    }
    return {
      success: res.success,
      outputPath: res.success ? args.outputPath : undefined,
      error: res.success ? undefined : res.stderr.slice(0, 300),
    };
  }
}

function findOutput(args: string[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a.startsWith('-')) continue;
    if (i > 0 && args[i - 1] === '-i') continue;
    return a;
  }
  return undefined;
}
