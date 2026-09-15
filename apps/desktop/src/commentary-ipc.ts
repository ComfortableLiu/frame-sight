import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CommentaryVideoService } from './commentary-video.service.js';
import { localMediaUrl, registerLocalMedia, resolveLocalMediaToken } from './local-media-protocol.js';
import { VoiceConfigService } from './voice-config.service.js';

interface AdVideoRecord {
  id: string;
  name: string;
  description: string;
  filePath: string;
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}

/** 校验路径段：禁止 ..、绝对路径、空段。 */
function isSafePathSegment(seg: string): boolean {
  if (!seg || typeof seg !== 'string') return false;
  if (seg.includes('..') || seg.includes('\0')) return false;
  if (path.isAbsolute(seg)) return false;
  if (/^[a-zA-Z]:/.test(seg)) return false;
  return true;
}

function safeJoinUnder(root: string, ...parts: string[]): string | null {
  for (const p of parts) {
    if (!isSafePathSegment(p)) return null;
  }
  const abs = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

async function extractAudioBase64(res: Response): Promise<string | null> {
  const json = (await res.json()) as {
    choices?: Array<{ message?: { audio?: { data?: string }; content?: unknown } }>;
  };
  const msg = json?.choices?.[0]?.message;
  if (msg?.audio?.data) return msg.audio.data;
  const content = msg?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p as { text?: string })?.text ?? '').join('')
        : '';
  const dataUrl = text.match(/data:audio\/[^;]+;base64,([A-Za-z0-9+/=\s]+)/);
  if (dataUrl) return dataUrl[1].replace(/\s/g, '');
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const audioRes = await fetch(urlMatch[0]).catch(() => null);
    if (audioRes?.ok) {
      const buf = await audioRes.arrayBuffer();
      if (buf.byteLength) return arrayBufferToBase64(buf);
    }
  }
  return null;
}

export function registerCommentaryIpcHandlers(mediaRoot: string): void {
  const service = new CommentaryVideoService(mediaRoot);
  const voiceConfig = new VoiceConfigService();
  const adVideosFile = path.join(mediaRoot, 'commentary', 'ad-videos.json');
  fs.mkdirSync(path.dirname(adVideosFile), { recursive: true });

  const loadAds = (): AdVideoRecord[] => {
    try {
      if (!fs.existsSync(adVideosFile)) return [];
      const raw = JSON.parse(fs.readFileSync(adVideosFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  const saveAds = (items: AdVideoRecord[]) => {
    fs.writeFileSync(adVideosFile, JSON.stringify(items, null, 2), 'utf8');
  };

  // ── 文件选择 ──
  ipcMain.handle('vp:pick-image-file', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win ?? ({} as never), {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const filePath = res.filePaths[0];
    return { canceled: false, filePath, previewUrl: localMediaUrl('image', filePath) };
  });

  ipcMain.handle('vp:pick-audio-file', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win ?? ({} as never), {
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const filePath = res.filePaths[0];
    return { canceled: false, filePath, previewUrl: localMediaUrl('bgm', filePath) };
  });

  ipcMain.handle('vp:get-image-preview-url', (_e, filePath: string) => {
    try {
      return { previewUrl: localMediaUrl('image', filePath) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── prepared / probe ──
  ipcMain.handle('vp:probe-source-preview', async (_e, input: { filePath: string }) => {
    try {
      const info = await service.probe(input.filePath);
      const codecNeedTranscode = false;
      return { ...info, needTranscode: codecNeedTranscode || !input.filePath.toLowerCase().endsWith('.mp4') };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:prepare-source', async (_e, input: { filePath: string }) => {
    try {
      return await service.prepareSource(input);
    } catch (err) {
      return {
        preparedId: '',
        inputPath: '',
        sourceUrl: '',
        durationSeconds: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── 裁剪 / 合并 / 字幕 ──
  ipcMain.handle('vp:clip-segment', (_e, args: { preparedId: string; partNumber: number | string; segmentIndex: number; startMs: number; endMs: number; inputPath?: string }) => {
    if (!isSafePathSegment(String(args.preparedId || ''))) {
      return Promise.reject(new Error('非法 preparedId'));
    }
    return service.clipSegment(args);
  });
  ipcMain.handle('vp:merge-segment-with-voice', (_e, args) => service.mergeSegmentWithVoice(args));
  ipcMain.handle('vp:burn-subtitles', (_e, args) => service.burnSubtitles(args));
  ipcMain.handle('vp:get-media-duration-seconds', (_e, filePath: string) =>
    service.getDuration(filePath),
  );
  ipcMain.handle('vp:extract-audio-to-wav', (_e, inputPath: string) =>
    service.extractAudioToWav(inputPath),
  );
  ipcMain.handle('vp:compress-video-for-upload', (_e, args) => service.compressVideoForUpload(args));
  ipcMain.handle('vp:change-audio-speed', async (_e, args: { inputPath: string; speed: number; outputPath: string }) => {
    try {
      await service.changeAudioSpeed(args.inputPath, args.speed, args.outputPath);
      return { success: true, outputPath: args.outputPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── 成片 ──
  ipcMain.handle('vp:compose-part-video', (_e, args) => service.composePartVideo(args));
  ipcMain.handle('vp:compose-progress-status', () => service.getComposeProgress());
  ipcMain.handle('vp:compose-progress-cancel', () => service.cancelCompose());
  ipcMain.handle('vp:compose-cover-video', (_e, args) => service.composeCoverVideo(args));
  ipcMain.handle('vp:compose-ad-video', (_e, args) => service.composeAdVideo(args));
  ipcMain.handle('vp:preview-vocal-isolation', (_e, args) => service.previewVocalIsolation(args));

  // ── 导出 ──
  ipcMain.handle('vp:export-part-video', async (_e, payload: { outputPath: string; defaultFileName?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win ?? ({} as never), {
      defaultPath: payload.defaultFileName || 'output.mp4',
      filters: [{ name: '视频', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await service.exportCopy(payload.outputPath, res.filePath);
    return { canceled: false, outputPath: res.filePath };
  });

  ipcMain.handle('vp:export-all-videos', async (_e, payload: { items: Array<{ outputPath: string; fileName: string }> }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win ?? ({} as never), {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const dir = res.filePaths[0];
    for (const item of payload.items || []) {
      if (!item?.outputPath || !fs.existsSync(item.outputPath)) continue;
      const safeName = path.basename(item.fileName || path.basename(item.outputPath)).replace(/[\\/:*?"<>|]/g, '_');
      const dest = safeJoinUnder(dir, safeName);
      if (!dest) continue;
      await service.exportCopy(item.outputPath, dest);
    }
    return { canceled: false, dir };
  });

  // ── 广告视频 ──
  ipcMain.handle('vp:ad-videos-list', () => {
    const items = loadAds().map((a) => ({
      ...a,
      previewUrl: fs.existsSync(a.filePath) ? localMediaUrl('advideo', a.filePath) : '',
    }));
    return { items };
  });
  ipcMain.handle('vp:ad-videos-add', (_e, payload: { name: string; description: string; filePath: string }) => {
    const items = loadAds();
    const id = `ad_${Date.now()}`;
    items.push({
      id,
      name: payload.name,
      description: payload.description || '',
      filePath: payload.filePath,
    });
    saveAds(items);
    return { ok: true, id };
  });
  ipcMain.handle('vp:ad-videos-update', (_e, payload: { id: string; name: string; description: string }) => {
    const items = loadAds();
    const idx = items.findIndex((x) => x.id === payload.id);
    if (idx >= 0) {
      items[idx].name = payload.name;
      items[idx].description = payload.description || '';
      saveAds(items);
    }
    return { ok: idx >= 0 };
  });
  ipcMain.handle('vp:ad-videos-delete', (_e, id: string) => {
    const items = loadAds().filter((x) => x.id !== id);
    saveAds(items);
    return { ok: true };
  });

  // ── 字体 ──
  ipcMain.handle('vp:list-custom-fonts', () => {
    const fontDirs = [
      path.join(app.getPath('userData'), 'fonts'),
      path.join(os.homedir(), 'Library/Fonts'),
      '/System/Library/Fonts',
      '/Library/Fonts',
      'C:/Windows/Fonts',
    ];
    const items: Array<{ id: string; alias: string; filePath: string; previewUrl: string }> = [];
    const exts = new Set(['.ttf', '.otf', '.ttc']);
    for (const dir of fontDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir).slice(0, 80);
        for (const e of entries) {
          const ext = path.extname(e).toLowerCase();
          if (!exts.has(ext)) continue;
          const filePath = path.join(dir, e);
          const id = `font_${items.length}`;
          items.push({
            id,
            alias: path.basename(e, ext),
            filePath,
            previewUrl: localMediaUrl('image', filePath),
          });
          if (items.length >= 40) break;
        }
      } catch {
        /* ignore */
      }
      if (items.length >= 40) break;
    }
    if (!items.length) {
      const fallback = service.resolveWatermarkFontPath();
      if (fallback) {
        items.push({
          id: 'font_system',
          alias: path.basename(fallback),
          filePath: fallback,
          previewUrl: localMediaUrl('image', fallback),
        });
      }
    }
    return { items };
  });

  // ── TTS ──
  ipcMain.handle('vp:generate-voice', async (_e, args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    text: string;
    voiceId?: string;
    speed?: number;
  }) => {
    const cfg = voiceConfig.getConfig().synthesis;
    if (!cfg?.enabled) {
      throw new Error('未启用语音合成，请在设置 → 语音设置中启用并配置');
    }
    if (!cfg.apiBase || !cfg.apiKey || !cfg.model) {
      throw new Error('语音合成未完整配置（API Base / Key / 模型）');
    }
    const text = String(args.text || '').trim();
    if (!text) throw new Error('合成文本不能为空');
    const voice = args.voiceId || cfg.voice || undefined;
    const format = ['wav', 'mp3', 'pcm'].includes(cfg.format) ? cfg.format : 'wav';
    const messages: Array<{ role: string; content: string }> = [];
    if (cfg.style?.trim()) messages.push({ role: 'user', content: cfg.style.trim() });
    messages.push({ role: 'assistant', content: text });

    const url = joinUrl(cfg.apiBase, '/chat/completions');
    const body = {
      model: cfg.model,
      messages,
      audio: { format, ...(voice ? { voice } : {}) },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': cfg.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`语音合成失败 ${res.status}: ${errText.slice(0, 200)}`);
    }
    const base64 = await extractAudioBase64(res);
    if (!base64) throw new Error('语音合成为空结果');

    const dir = path.join(
      mediaRoot,
      'voices',
      isSafePathSegment(args.preparedId || 'default') ? args.preparedId : 'default',
      `part_${String(args.partNumber).padStart(3, '0').replace(/\D/g, '0')}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    const seg = String(args.segmentIndex).padStart(3, '0');
    const ext = format === 'pcm' ? 'pcm' : format;
    const rawPath = path.join(dir, `seg_${seg}_raw.${ext}`);
    fs.writeFileSync(rawPath, Buffer.from(base64, 'base64'));

    let outputPath = rawPath;
    const speed = args.speed ?? 1;
    if (Math.abs(speed - 1) > 0.01) {
      outputPath = path.join(dir, `seg_${seg}.${ext === 'pcm' ? 'wav' : ext}`);
      try {
        await service.changeAudioSpeed(rawPath, speed, outputPath);
      } catch {
        outputPath = rawPath;
      }
    }
    return {
      outputPath,
      audioUrl: localMediaUrl('voice', outputPath),
    };
  });

  // ── 上传包装（S3） ──
  ipcMain.handle('vp:upload-commentary-media', async (_e, filePath: string) => {
    try {
      const { StorageService } = await import('./storage.service.js');
      const storage = new StorageService();
      const { objectUrl, error } = await storage.uploadFile(filePath);
      if (error) return { url: '', error };
      return { url: objectUrl };
    } catch (err) {
      return { url: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── resolve local media（调试） ──
  ipcMain.handle('vp:resolve-local-media', (_e, token: string) => ({
    absPath: resolveLocalMediaToken(token) || '',
  }));

  // 保存本地文件并注册
  ipcMain.handle('vp:save-commentary-file', (_e, payload: { relPath: string; content: string }) => {
    try {
      const abs = safeJoinUnder(path.join(mediaRoot, 'commentary'), payload.relPath);
      if (!abs) return { success: false, error: '非法相对路径' };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, payload.content, 'utf8');
      return { success: true, absPath: abs };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
