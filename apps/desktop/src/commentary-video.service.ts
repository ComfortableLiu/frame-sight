import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { localMediaUrl, registerLocalMedia } from './local-media-protocol.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ComposeProgressSnapshot {
  active: boolean;
  status: 'idle' | 'running' | 'cancelled' | 'done' | 'error';
  step?: string;
  processed?: number;
  total?: number;
  partNumber?: number;
  detail?: string;
  ratio?: number;
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH ?? 'ffprobe';
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function run(cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<RunResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts?.cwd });
    } catch (err) {
      resolve({
        success: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;
    const finish = (r: RunResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 2_000_000) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 2_000_000) stderr += d.toString();
    });
    child.on('close', (code) =>
      finish({ success: code === 0 && !timedOut, stdout, stderr, exitCode: code }),
    );
    child.on('error', (err) =>
      finish({ success: false, stdout, stderr: err.message, exitCode: null }),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({
        success: false,
        stdout,
        stderr: stderr + '\n[timeout]',
        exitCode: null,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runFfmpeg(args: string[]): Promise<RunResult> {
  return run(ffmpegBin(), ['-y', ...args]);
}

export interface ProbeInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** 解说模式媒体服务：标准编码 + local-media URL。 */
export class CommentaryVideoService {
  private mediaRoot: string;
  private preparedCache = new Map<string, { preparedId: string; inputPath: string; sourceUrl: string; durationSeconds: number | null }>();
  private composeProgress: ComposeProgressSnapshot = { active: false, status: 'idle' };
  private composeAbort: AbortController | null = null;

  constructor(mediaRoot: string) {
    this.mediaRoot = mediaRoot;
    for (const sub of ['clips', 'voices', 'merged', 'final', 'step6', 'step7', 'prepared', 'tmp']) {
      fs.mkdirSync(path.join(mediaRoot, sub), { recursive: true });
    }
  }

  private abs(...parts: string[]): string {
    return path.join(this.mediaRoot, ...parts);
  }

  getComposeProgress(): ComposeProgressSnapshot {
    return { ...this.composeProgress };
  }

  cancelCompose(): { ok: boolean } {
    if (this.composeAbort) {
      this.composeAbort.abort();
      this.composeProgress = { ...this.composeProgress, status: 'cancelled', detail: '用户取消' };
      return { ok: true };
    }
    return { ok: false };
  }

  private setProgress(p: Partial<ComposeProgressSnapshot>): void {
    this.composeProgress = { ...this.composeProgress, ...p };
  }

  async probe(filePath: string): Promise<ProbeInfo> {
    const res = await run(ffprobeBin(), [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate:stream=codec_type,width,height,avg_frame_rate',
      '-of', 'json',
      filePath,
    ]);
    if (!res.success) {
      // fallback: ffmpeg -i
      const fr = await runFfmpeg(['-i', filePath, '-f', 'null', '-']);
      const m = fr.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      const size = fr.stderr.match(/Stream.*Video.*,?\s(\d+)x(\d+)/);
      return {
        durationSeconds: m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : null,
        width: size ? parseInt(size[1]) : null,
        height: size ? parseInt(size[2]) : null,
        fps: null,
        bitrateKbps: null,
        hasVideo: /Stream.*Video/.test(fr.stderr),
        hasAudio: /Stream.*Audio/.test(fr.stderr),
      };
    }
    try {
      const json = JSON.parse(res.stdout);
      const streams = json.streams || [];
      const v = streams.find((s: { codec_type?: string }) => s.codec_type === 'video');
      const a = streams.find((s: { codec_type?: string }) => s.codec_type === 'audio');
      let fps: number | null = null;
      if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
        const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
        if (d) fps = n / d;
      }
      const dur = json.format?.duration != null ? parseFloat(json.format.duration) : null;
      const br = json.format?.bit_rate != null ? Math.round(parseFloat(json.format.bit_rate) / 1000) : null;
      return {
        durationSeconds: Number.isFinite(dur) ? dur : null,
        width: v?.width ?? null,
        height: v?.height ?? null,
        fps,
        bitrateKbps: br,
        hasVideo: Boolean(v),
        hasAudio: Boolean(a),
      };
    } catch {
      return {
        durationSeconds: null,
        width: null,
        height: null,
        fps: null,
        bitrateKbps: null,
        hasVideo: false,
        hasAudio: false,
      };
    }
  }

  async getDuration(filePath: string): Promise<{ durationSeconds: number }> {
    const info = await this.probe(filePath);
    return { durationSeconds: info.durationSeconds ?? 0 };
  }

  /** 统一编码参数 */
  private encodeArgs(): string[] {
    return [
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
    ];
  }

  async prepareSource(input: { filePath: string }): Promise<{
    preparedId: string;
    inputPath: string;
    sourceUrl: string;
    durationSeconds: number | null;
  }> {
    const filePath = path.resolve(input.filePath);
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const hit = this.preparedCache.get(cacheKey);
    if (hit) return hit;

    const preparedId = createHash('sha1').update(cacheKey).digest('hex').slice(0, 16);
    const info = await this.probe(filePath);
    const needsTranscode = !filePath.toLowerCase().endsWith('.mp4');
    let inputPath = filePath;
    if (needsTranscode) {
      inputPath = this.abs('prepared', `${preparedId}.mp4`);
      const res = await runFfmpeg(['-i', filePath, ...this.encodeArgs(), inputPath]);
      if (!res.success) throw new Error(`转码失败: ${res.stderr.slice(0, 300)}`);
    }
    const sourceUrl = localMediaUrl('prepared', inputPath);
    const result = {
      preparedId,
      inputPath,
      sourceUrl,
      durationSeconds: info.durationSeconds,
    };
    this.preparedCache.set(cacheKey, result);
    registerLocalMedia('prepared', inputPath);
    return result;
  }

  async clipSegment(args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    startMs: number;
    endMs: number;
    inputPath?: string;
  }): Promise<{ outputPath: string; segmentUrl: string; durationSeconds: number }> {
    const inputPath = args.inputPath || this.resolvePreparedPath(args.preparedId);
    const start = Math.max(0, Math.floor(args.startMs));
    const end = Math.max(start + 1, Math.floor(args.endMs));
    const dir = this.abs('clips', args.preparedId, `part_${String(args.partNumber).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, `seg_${String(args.segmentIndex).padStart(3, '0')}.mp4`);
    const duration = (end - start) / 1000;
    const res = await runFfmpeg([
      '-ss', (start / 1000).toString(),
      '-i', inputPath,
      '-t', duration.toString(),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...this.encodeArgs(),
      outputPath,
    ]);
    if (!res.success) throw new Error(`裁剪失败: ${res.stderr.slice(0, 400)}`);
    const info = await this.probe(outputPath);
    return {
      outputPath,
      segmentUrl: localMediaUrl('clips', outputPath),
      durationSeconds: info.durationSeconds ?? duration,
    };
  }

  private resolvePreparedPath(preparedId: string): string {
    for (const v of this.preparedCache.values()) {
      if (v.preparedId === preparedId) return v.inputPath;
    }
    const guess = this.abs('prepared', `${preparedId}.mp4`);
    if (fs.existsSync(guess)) return guess;
    throw new Error(`找不到 preparedId=${preparedId} 对应源文件`);
  }

  async extractAudioToWav(inputPath: string): Promise<{ outputPath: string }> {
    const outputPath = this.abs('tmp', `audio_${Date.now()}.wav`);
    const res = await runFfmpeg([
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);
    if (!res.success) throw new Error(`抽音频失败: ${res.stderr.slice(0, 300)}`);
    return { outputPath };
  }

  async compressVideoForUpload(args: {
    inputPath: string;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  }): Promise<{ outputPath: string }> {
    const W = even(args.width || 640);
    const H = even(args.height || 360);
    const F = Math.max(1, Math.floor(args.fps || 30));
    const b = Math.max(100, Math.floor(args.bitrateKbps || 900));
    const outputPath = this.abs('tmp', `upload_${Date.now()}.mp4`);
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${F}`;
    const res = await runFfmpeg([
      '-i', args.inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.2)}k`, '-bufsize', `${b * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ]);
    if (!res.success) throw new Error(`压缩失败: ${res.stderr.slice(0, 300)}`);
    return { outputPath };
  }

  async changeAudioSpeed(inputPath: string, speed: number, outputPath: string): Promise<void> {
    const s = clamp(speed, 0.5, 2.0);
    if (Math.abs(s - 1) < 0.01) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }
    const res = await runFfmpeg(['-i', inputPath, '-filter:a', `atempo=${s}`, outputPath]);
    if (!res.success) throw new Error(`变速失败: ${res.stderr.slice(0, 300)}`);
  }

  async mergeSegmentWithVoice(args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    segmentPath: string;
    voicePath: string;
    inputPath: string;
    startMs: number;
  }): Promise<{ outputPath: string; outputUrl: string }> {
    const voiceDur = (await this.getDuration(args.voicePath)).durationSeconds;
    const sourceStartMs = Math.max(0, Math.floor(args.startMs));
    const sourceEndMs = sourceStartMs + Math.floor(voiceDur * 1000) + 80;
    const dir = this.abs('merged', args.preparedId, `part_${String(args.partNumber).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    const baseName = `seg_${String(args.segmentIndex).padStart(3, '0')}`;
    const clipPath = path.join(dir, `${baseName}_src.mp4`);
    const outputPath = path.join(dir, `${baseName}.mp4`);

    const clipRes = await runFfmpeg([
      '-ss', (sourceStartMs / 1000).toString(),
      '-i', args.inputPath,
      '-t', ((sourceEndMs - sourceStartMs) / 1000).toString(),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...this.encodeArgs(),
      clipPath,
    ]);
    if (!clipRes.success) throw new Error(`重裁失败: ${clipRes.stderr.slice(0, 300)}`);

    const mergeRes = await runFfmpeg([
      '-i', clipPath,
      '-i', args.voicePath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-shortest',
      '-movflags', '+faststart',
      outputPath,
    ]);
    if (!mergeRes.success) throw new Error(`合并失败: ${mergeRes.stderr.slice(0, 300)}`);
    return { outputPath, outputUrl: localMediaUrl('merged', outputPath) };
  }

  private splitTextToSubtitlePieces(text: string, maxLen = 15): string[] {
    const t = text.replace(/\s+/g, '').trim();
    if (!t) return [];
    const pieces: string[] = [];
    let buf = '';
    for (const ch of t) {
      buf += ch;
      if (buf.length >= maxLen || /[，。！？；、,.!?;:]/.test(ch)) {
        if (buf.length >= 4 || /[，。！？；、,.!?;:]/.test(ch)) {
          pieces.push(buf);
          buf = '';
        }
      }
    }
    if (buf) pieces.push(buf);
    return pieces.length ? pieces : [t.slice(0, maxLen)];
  }

  private hexToAssBgr(hex: string): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return '&H00FFFFFF&';
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `&H00${b}${g}${r}&`.toUpperCase();
  }

  async burnSubtitles(args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    mergedVideoPath: string;
    voiceAudioPath: string;
    text: string;
    marginV?: number;
    fontSize?: number;
    fontColor?: string;
    bold?: boolean;
    outlineEnabled?: boolean;
    outlineSize?: number;
    outlineColor?: string;
  }): Promise<{ outputPath: string; url: string; srtPath: string }> {
    const settings = {
      marginV: args.marginV ?? 30,
      fontSize: args.fontSize ?? 28,
      fontColor: args.fontColor ?? '#FFFFFF',
      bold: args.bold ?? false,
      outlineEnabled: args.outlineEnabled ?? true,
      outlineSize: args.outlineSize ?? 2,
      outlineColor: args.outlineColor ?? '#000000',
    };
    const totalMs = Math.max(50, Math.round((await this.getDuration(args.voiceAudioPath)).durationSeconds * 1000));
    const pieces = this.splitTextToSubtitlePieces(args.text, 15);
    const nonEmpty = pieces.map((p) => p.replace(/\s/g, '').length);
    const totalChars = nonEmpty.reduce((a, b) => a + b, 0) || 1;
    let cursor = 0;
    const cues: Array<{ start: number; end: number; text: string }> = [];
    for (let i = 0; i < pieces.length; i++) {
      const share = nonEmpty[i] / totalChars;
      let dur = Math.max(50, Math.round(totalMs * share));
      if (i === pieces.length - 1) dur = totalMs - cursor;
      cues.push({ start: cursor, end: Math.max(cursor + 50, cursor + dur), text: pieces[i] });
      cursor += dur;
    }
    const toSrtTime = (ms: number) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const f = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`;
    };
    const srt = cues
      .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}\n`)
      .join('\n');

    const hash = createHash('sha1')
      .update(
        [
          args.mergedVideoPath,
          args.voiceAudioPath,
          srt,
          `${settings.marginV},${settings.fontSize},${settings.fontColor},${settings.bold},${settings.outlineEnabled},${settings.outlineSize}`,
        ].join('::'),
      )
      .digest('hex')
      .slice(0, 8);

    const dir = this.abs('merged', args.preparedId, `part_${String(args.partNumber).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    const srtPath = path.join(dir, `seg_${String(args.segmentIndex).padStart(3, '0')}_subtitled_${hash}.srt`);
    const outputPath = path.join(dir, `seg_${String(args.segmentIndex).padStart(3, '0')}_subtitled_${hash}.mp4`);
    if (fs.existsSync(outputPath)) {
      return { outputPath, url: localMediaUrl('subtitled', outputPath), srtPath };
    }
    fs.writeFileSync(srtPath, srt, 'utf8');

    const probe = await this.probe(args.mergedVideoPath);
    const playResX = probe.width || 1080;
    const playResY = probe.height || 1920;
    const forceStyle = [
      `PlayResX=${playResX}`,
      `PlayResY=${playResY}`,
      `FontName=Arial`,
      `FontSize=${Math.round(settings.fontSize * 1.5)}`,
      `PrimaryColour=${this.hexToAssBgr(settings.fontColor)}`,
      `OutlineColour=${this.hexToAssBgr(settings.outlineColor)}`,
      `Outline=${settings.outlineEnabled ? settings.outlineSize : 0}`,
      `Bold=${settings.bold ? 1 : 0}`,
      `BorderStyle=1`,
      `Shadow=0`,
      `Alignment=2`,
      `MarginV=${settings.marginV}`,
    ].join(',');

    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const escapedStyle = forceStyle.replace(/'/g, "\\'");
    const res = await runFfmpeg([
      '-i', args.mergedVideoPath,
      '-vf', `subtitles='${escapedSrt}':force_style='${escapedStyle}'`,
      '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-movflags', '+faststart',
      outputPath,
    ]);
    if (!res.success) throw new Error(`烧录字幕失败: ${res.stderr.slice(0, 400)}`);
    return { outputPath, url: localMediaUrl('subtitled', outputPath), srtPath };
  }

  async concatVideos(paths: string[], outputPath: string): Promise<void> {
    if (!paths.length) throw new Error('没有可拼接的片段');
    const listPath = path.join(path.dirname(outputPath), `concat_${Date.now()}.txt`);
    const list = paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, list, 'utf8');
    try {
      const res = await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
      if (!res.success) throw new Error(`拼接失败: ${res.stderr.slice(0, 400)}`);
    } finally {
      try {
        fs.unlinkSync(listPath);
      } catch {
        /* ignore */
      }
    }
  }

  async cropToAspectRatio(inputPath: string, outputPath: string, ratio: string): Promise<void> {
    const map: Record<string, [number, number]> = {
      '16:9': [1920, 1080],
      '4:3': [1440, 1080],
      '9:16': [1080, 1920],
      '3:4': [1080, 1440],
    };
    const target = map[ratio];
    if (!target) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }
    const [tw, th] = target;
    const dstRatio = tw / th;
    const info = await this.probe(inputPath);
    if (!info.width || !info.height) {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }
    const srcRatio = info.width / info.height;
    let outW = even(info.width);
    let outH = even(info.height);
    let x = 0;
    let y = 0;
    if (srcRatio > dstRatio) {
      outH = even(info.height);
      outW = even(Math.min(info.width, Math.floor(outH * dstRatio)));
      x = even(Math.floor((info.width - outW) / 2));
    } else if (srcRatio < dstRatio) {
      outW = even(info.width);
      outH = even(Math.min(info.height, Math.floor(outW / dstRatio)));
      y = even(Math.floor((info.height - outH) / 2));
    } else {
      fs.copyFileSync(inputPath, outputPath);
      return;
    }
    const res = await runFfmpeg([
      '-i', inputPath,
      '-vf', `crop=${outW}:${outH}:${x}:${y}`,
      '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ]);
    if (!res.success) throw new Error(`画幅裁切失败: ${res.stderr.slice(0, 300)}`);
  }

  async adjustVolume(inputPath: string, outputPath: string, volume: number): Promise<void> {
    const v = clamp(volume, 0, 2);
    const res = await runFfmpeg([
      '-i', inputPath,
      '-c:v', 'copy',
      '-filter:a', `volume=${v}`,
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      outputPath,
    ]);
    if (!res.success) throw new Error(`音量调节失败: ${res.stderr.slice(0, 300)}`);
  }

  async mixBackgroundMusic(args: {
    videoPath: string;
    bgmPath: string;
    bgmVolume: number;
    outputPath: string;
  }): Promise<void> {
    const vol = clamp(args.bgmVolume, 0, 1);
    const mainDur = (await this.getDuration(args.videoPath)).durationSeconds;
    const T = mainDur + 0.75;
    const fade = 1.2;
    const cycle = Math.max(fade + 0.1, 8);
    const expr = `${vol.toFixed(3)}*if(lt(mod(t,${cycle.toFixed(2)}),${fade.toFixed(2)}),mod(t,${cycle.toFixed(2)})/${fade.toFixed(2)},1)`.replace(
      /,/g,
      '\\,',
    );
    const filter =
      `[1:a]asetpts=N/SR/TB,volume='${expr}'[bgm];` +
      `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0,apad=whole_dur=${T.toFixed(3)}[aout]`;
    const res = await runFfmpeg([
      '-i', args.videoPath,
      '-stream_loop', '-1',
      '-i', args.bgmPath,
      '-filter_complex', filter,
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-t', T.toFixed(3),
      args.outputPath,
    ]);
    if (!res.success) throw new Error(`BGM 混音失败: ${res.stderr.slice(0, 400)}`);
  }

  resolveWatermarkFontPath(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'darwin') {
      candidates.push(
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Light.ttc',
        '/Library/Fonts/Arial Unicode.ttf',
      );
    } else if (process.platform === 'win32') {
      candidates.push('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf');
    } else {
      candidates.push(
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      );
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  async applyMovingWatermark(args: {
    inputPath: string;
    outputPath: string;
    text: string;
    opacity: number;
    fontSize: number;
  }): Promise<void> {
    const opa = clamp(args.opacity, 0.06, 0.55);
    const fontSize = clamp(args.fontSize, 12, 96);
    const font = this.resolveWatermarkFontPath();
    if (!font) {
      fs.copyFileSync(args.inputPath, args.outputPath);
      return;
    }
    const tmpDir = this.abs('tmp');
    const txtPath = path.join(tmpDir, `wm_${Date.now()}.txt`);
    fs.writeFileSync(txtPath, args.text, 'utf8');
    // 16s 四边轮换
    const xTop = `0.04*w+mod(t*100\\,w*0.92-tw)+sin(t*4.2)*w*0.02`;
    const yLeft = `0.04*h+mod(t*100\\,h*0.92-th)+sin(t*4.2)*h*0.02`;
    const xExpr = `if(lt(mod(t\\,16)\\,4)\\,${xTop}\\,if(lt(mod(t\\,16)\\,8)\\,${xTop}\\,if(lt(mod(t\\,16)\\,12)\\,0.04*w\\,w-tw-0.04*w)))`;
    const yExpr = `if(lt(mod(t\\,16)\\,4)\\,0.04*h\\,if(lt(mod(t\\,16)\\,8)\\,h-th-0.04*h\\,if(lt(mod(t\\,16)\\,12)\\,${yLeft}\\,${yLeft})))`;
    const fontEsc = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    const txtEsc = txtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const vf = `drawtext=fontfile='${fontEsc}':textfile='${txtEsc}':fontsize=${fontSize}:fontcolor=white@${opa.toFixed(2)}:x='${xExpr}':y='${yExpr}':shadowcolor=black@0.42:shadowx=1:shadowy=1`;
    const res = await runFfmpeg([
      '-i', args.inputPath,
      '-vf', vf,
      '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      args.outputPath,
    ]);
    try {
      fs.unlinkSync(txtPath);
    } catch {
      /* ignore */
    }
    if (!res.success) throw new Error(`水印失败: ${res.stderr.slice(0, 400)}`);
  }

  async transcodeBitrate(inputPath: string, outputPath: string, bitrateKbps: number): Promise<void> {
    const b = clamp(Math.floor(bitrateKbps), 100, 100000) || 3000;
    const res = await runFfmpeg([
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.2)}k`, '-bufsize', `${b * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ]);
    if (!res.success) throw new Error(`码率转码失败: ${res.stderr.slice(0, 300)}`);
  }

  /** FFmpeg arnndn 降噪（模型不可用时直接复制） */
  async extractVocalsFfmpeg(
    inputPath: string,
    mix: number,
  ): Promise<{ outputPath: string; usedModel: boolean }> {
    const tmp = this.abs('tmp', `vocals_${Date.now()}.wav`);
    const extract = await runFfmpeg([
      '-i', inputPath,
      '-vn', '-ac', '2', '-ar', '44100',
      '-c:a', 'pcm_s16le',
      tmp,
    ]);
    if (!extract.success) throw new Error(`抽取人声轨失败: ${extract.stderr.slice(0, 200)}`);
    // 尝试常见 arnndn 模型路径；找不到则原样返回
    const modelCandidates = [
      path.join(process.resourcesPath || '', 'models', 'arnndn-model'),
      path.join(os.homedir(), '.cache/frame-sight/arnndn-model'),
    ].filter(Boolean);
    const model = modelCandidates.find((p) => fs.existsSync(p));
    if (!model) {
      return { outputPath: tmp, usedModel: false };
    }
    const out = this.abs('tmp', `vocals_m_${Date.now()}.wav`);
    const m = clamp(mix, 0, 1).toFixed(2);
    const modelEsc = model.replace(/\\/g, '/').replace(/'/g, "\\'");
    const res = await runFfmpeg([
      '-i', tmp,
      '-af', `arnndn=m='${modelEsc}':mix=${m}`,
      '-ac', '2', '-ar', '44100',
      '-c:a', 'pcm_s16le',
      out,
    ]);
    if (!res.success || !fs.existsSync(out) || fs.statSync(out).size < 2048) {
      return { outputPath: tmp, usedModel: false };
    }
    return { outputPath: out, usedModel: true };
  }

  async previewVocalIsolation(args: {
    inputVideoPath: string;
    vocalIsolationMix: number;
  }): Promise<{ previewUrl: string }> {
    const { outputPath } = await this.extractVocalsFfmpeg(args.inputVideoPath, args.vocalIsolationMix);
    return { previewUrl: localMediaUrl('voice', outputPath) };
  }

  async composePartVideo(args: {
    preparedId: string;
    partNumber: number | string;
    segments: Array<{ videoPath: string; type: 'commentary' | 'original_clip'; removeBackgroundAudio?: boolean }>;
    backgroundMusicPath?: string;
    backgroundMusicVolume?: number;
    originalClipVolume?: number;
    vocalIsolationMix?: number;
    watermarkText?: string;
    watermarkOpacity?: number;
    watermarkFontSize?: number;
    forcedAspectRatio?: string;
    videoBitrateKbps?: number;
  }): Promise<{ outputPath: string; finalUrl: string }> {
    this.composeAbort = new AbortController();
    this.setProgress({
      active: true,
      status: 'running',
      step: '预处理',
      processed: 0,
      total: args.segments.length,
      partNumber: Number(args.partNumber) || 1,
      ratio: 0.05,
    });

    const tmpRoot = this.abs('tmp', `compose_${Date.now()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    try {
      const prepared: string[] = [];
      for (let i = 0; i < args.segments.length; i++) {
        if (this.composeAbort.signal.aborted) throw new Error('cancelled');
        const seg = args.segments[i];
        this.setProgress({ step: '预处理片段', processed: i, ratio: 0.05 + (i / args.segments.length) * 0.35 });
        let p = seg.videoPath;
        if (
          args.backgroundMusicPath &&
          seg.type === 'original_clip' &&
          seg.removeBackgroundAudio
        ) {
          const { outputPath: vocals } = await this.extractVocalsFfmpeg(
            p,
            args.vocalIsolationMix ?? 0.35,
          );
          const replaced = path.join(tmpRoot, `iso_${i}.mp4`);
          const merge = await runFfmpeg([
            '-i', p, '-i', vocals,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
            '-shortest', replaced,
          ]);
          if (merge.success) p = replaced;
        }
        if (seg.type === 'original_clip' && args.originalClipVolume != null && Math.abs(args.originalClipVolume - 1) > 0.01) {
          const volPath = path.join(tmpRoot, `vol_${i}.mp4`);
          await this.adjustVolume(p, volPath, args.originalClipVolume);
          if (fs.existsSync(volPath)) p = volPath;
        }
        prepared.push(p);
      }

      // 强制画幅
      let ratioApplied = prepared;
      if (args.forcedAspectRatio && args.forcedAspectRatio !== 'source') {
        this.setProgress({ step: '强制画幅', ratio: 0.5 });
        ratioApplied = [];
        for (let i = 0; i < prepared.length; i++) {
          const out = path.join(tmpRoot, `ratio_${i}.mp4`);
          await this.cropToAspectRatio(prepared[i], out, args.forcedAspectRatio);
          ratioApplied.push(fs.existsSync(out) ? out : prepared[i]);
        }
      }

      this.setProgress({ step: '拼接', ratio: 0.65 });
      const concatPath = path.join(tmpRoot, 'concat.mp4');
      await this.concatVideos(ratioApplied, concatPath);

      let current = concatPath;
      if (args.backgroundMusicPath) {
        this.setProgress({ step: '混入背景音乐', ratio: 0.75 });
        const bgmOut = path.join(tmpRoot, 'bgm.mp4');
        await this.mixBackgroundMusic({
          videoPath: current,
          bgmPath: args.backgroundMusicPath,
          bgmVolume: args.backgroundMusicVolume ?? 0.6,
          outputPath: bgmOut,
        });
        current = bgmOut;
      }
      if (args.watermarkText && args.watermarkText.trim()) {
        this.setProgress({ step: '水印', ratio: 0.85 });
        const wmOut = path.join(tmpRoot, 'wm.mp4');
        await this.applyMovingWatermark({
          inputPath: current,
          outputPath: wmOut,
          text: args.watermarkText.trim(),
          opacity: args.watermarkOpacity ?? 0.2,
          fontSize: args.watermarkFontSize ?? 26,
        });
        current = wmOut;
      }

      this.setProgress({ step: '码率转码', ratio: 0.92 });
      const dir = this.abs('final', args.preparedId);
      fs.mkdirSync(dir, { recursive: true });
      const outputPath = path.join(dir, `part_${String(args.partNumber).padStart(3, '0')}.mp4`);
      await this.transcodeBitrate(current, outputPath, args.videoBitrateKbps ?? 3000);

      this.setProgress({ active: false, status: 'done', ratio: 1, step: '完成' });
      return { outputPath, finalUrl: localMediaUrl('final', outputPath) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setProgress({
        active: false,
        status: msg.includes('cancel') ? 'cancelled' : 'error',
        detail: msg,
      });
      throw err;
    } finally {
      this.composeAbort = null;
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private normalizeHexColor(c: string, fallback: string): string {
    const h = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(h)) {
      return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`.toUpperCase();
    }
    return fallback;
  }

  private singleLine(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  async composeCoverVideo(args: {
    inputPath: string;
    coverImagePath?: string;
    coverDurationSec?: number;
    forcePortrait?: boolean;
    videoBitrateKbps?: number;
    texts: Array<{
      text: string;
      fontSize?: number;
      color?: string;
      outlineColor?: string;
      outlineWidth?: number;
      bold?: boolean;
      xPercent?: number;
      yPercent?: number;
      fontFamily?: string;
    }>;
  }): Promise<{ outputPath: string; finalUrl: string }> {
    const forcePortrait = args.forcePortrait !== false;
    const bitrate = clamp(Math.floor(args.videoBitrateKbps || 3000), 100, 100000);
    const outputPath = this.abs('step6', `${createHash('sha1').update(args.inputPath + Date.now()).digest('hex').slice(0, 12)}.mp4`);
    const font = this.resolveWatermarkFontPath();
    if (!font) throw new Error('未找到可用中文字体');

    const info = await this.probe(args.inputPath);
    const inputs: string[] = ['-i', args.inputPath];
    let canvasChain = forcePortrait
      ? `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setpts=PTS-STARTPTS[v0]`
      : `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setpts=PTS-STARTPTS[v0]`;

    let last = 'v0';
    let inputIdx = 1;
    if (args.coverImagePath && fs.existsSync(args.coverImagePath)) {
      inputs.push('-loop', '1', '-i', args.coverImagePath);
      const dur = clamp(args.coverDurationSec ?? 0, 0, 10);
      const enable = dur > 0 ? `between(t,0,${dur})` : `eq(n,0)`;
      const cw = forcePortrait ? 1080 : info.width || 1080;
      const ch = forcePortrait ? 1920 : info.height || 1920;
      canvasChain += `;[${inputIdx}:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}[cover];[${last}][cover]overlay=0:0:enable='${enable}'[vcover]`;
      last = 'vcover';
      inputIdx += 1;
    }

    let chain = canvasChain;
    let n = 0;
    for (const t of args.texts) {
      const text = this.singleLine(t.text);
      if (!text) continue;
      const fontSize = clamp(t.fontSize ?? 42, 12, 180);
      const outlineWidth = clamp(t.outlineWidth ?? 0, 0, 12);
      const color = this.normalizeHexColor(t.color || '#FFFFFF', '#FFFFFF');
      const outlineColor = this.normalizeHexColor(t.outlineColor || '#000000', '#000000');
      const xp = clamp(t.xPercent ?? 50, 0, 100) / 100;
      const yp = clamp(t.yPercent ?? 50, 0, 100) / 100;
      const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
      const fontEsc = font.replace(/\\/g, '/').replace(/:/g, '\\:');
      const xExpr = `((w-text_w-${outlineWidth * 2})*${xp.toFixed(4)}+${outlineWidth})`;
      const yExpr = `((h-text_h-${outlineWidth * 2})*${yp.toFixed(4)}+${outlineWidth})`;
      const shadow = t.bold ? ':shadowcolor=black@0.6:shadowx=1:shadowy=1' : '';
      const dt = `drawtext=fontfile='${fontEsc}':text='${escaped}':fontsize=${fontSize}:fontcolor=${color}:x=${xExpr}:y=${yExpr}:borderw=${outlineWidth}:bordercolor=${outlineColor}${shadow}:enable='gte(n\\,1)'`;
      chain += `;[${last}]${dt}[t${n}]`;
      last = `t${n}`;
      n += 1;
    }

    const ffArgs = [...inputs];
    if (args.coverImagePath && fs.existsSync(args.coverImagePath)) {
      // cover loop may extend duration; use -shortest with main audio
      ffArgs.push(
        '-filter_complex', chain,
        '-map', `[${last}]`, '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.2)}k`, '-bufsize', `${bitrate * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-shortest',
        '-movflags', '+faststart',
        outputPath,
      );
    } else {
      ffArgs.push(
        '-filter_complex', chain,
        '-map', `[${last}]`, '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.2)}k`, '-bufsize', `${bitrate * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
        outputPath,
      );
    }
    const res = await runFfmpeg(ffArgs);
    if (!res.success) throw new Error(`封面合成失败: ${res.stderr.slice(0, 500)}`);
    return { outputPath, finalUrl: localMediaUrl('step6', outputPath) };
  }

  async composeAdVideo(args: {
    inputPath: string;
    adVideoPath: string;
    adAudioPath: string;
    insertionTimeSec: number;
    videoBitrateKbps?: number;
  }): Promise<{ outputPath: string; finalUrl: string }> {
    const mainDur = (await this.getDuration(args.inputPath)).durationSeconds;
    const adAudioDur = Math.max(0.1, (await this.getDuration(args.adAudioPath)).durationSeconds);
    const insertion = clamp(args.insertionTimeSec, 0, Math.max(0, mainDur - 0.05));
    const bitrate = clamp(Math.floor(args.videoBitrateKbps || 3000), 100, 100000);

    const dir = this.abs('step7');
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, `${createHash('sha1').update(args.inputPath + Date.now()).digest('hex').slice(0, 12)}.mp4`);
    const tmpOut = path.join(dir, `tmp_${path.basename(outputPath)}`);

    const filter = [
      `[0:v]trim=0:${insertion.toFixed(3)},setpts=PTS-STARTPTS[v_pre]`,
      `[0:v]trim=start=${insertion.toFixed(3)},setpts=PTS-STARTPTS[v_post]`,
      `[0:v]trim=start=${insertion.toFixed(3)}:end=${(insertion + 0.04).toFixed(3)},setpts=PTS-STARTPTS[v_freeze_src]`,
      `[v_freeze_src]tpad=stop_mode=clone:stop_duration=${adAudioDur.toFixed(3)}[v_bg]`,
      `[1:v]trim=duration=${adAudioDur.toFixed(3)},setpts=PTS-STARTPTS[v_ad]`,
      `[v_bg][v_ad]overlay=(W-w)/2:(H-h)/2:shortest=1[v_mid]`,
      `[v_pre][v_mid][v_post]concat=n=3:v=1:a=0[v_out]`,
      `[0:a]atrim=0:${insertion.toFixed(3)},asetpts=PTS-STARTPTS[a_pre]`,
      `[0:a]atrim=start=${insertion.toFixed(3)},asetpts=PTS-STARTPTS[a_post]`,
      `[2:a]atrim=duration=${adAudioDur.toFixed(3)},asetpts=PTS-STARTPTS[a_ad]`,
      `[a_pre][a_ad][a_post]concat=n=3:v=0:a=1[a_out]`,
    ].join(';');

    const res = await runFfmpeg([
      '-i', args.inputPath,
      '-i', args.adVideoPath,
      '-i', args.adAudioPath,
      '-filter_complex', filter,
      '-map', '[v_out]', '-map', '[a_out]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      tmpOut,
    ]);
    if (!res.success) throw new Error(`广告合成失败: ${res.stderr.slice(0, 500)}`);
    await this.transcodeBitrate(tmpOut, outputPath, bitrate);
    try {
      fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
    return { outputPath, finalUrl: localMediaUrl('step7', outputPath) };
  }

  async exportCopy(sourcePath: string, destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  }
}
