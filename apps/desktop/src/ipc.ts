import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { VideoService } from './video.service.js';
import { ModelConfigService } from './model-config.service.js';
import { StorageService } from './storage.service.js';
import type { AgentScriptToolService } from './agent-script-tool.service.js';

export interface IpcDeps {
  mediaRoot: string;
  scriptService: AgentScriptToolService;
}

export function registerAllIpcHandlers(deps: IpcDeps): void {
  const { mediaRoot, scriptService } = deps;
  const videoService = new VideoService();
  const modelConfigService = new ModelConfigService();
  const storageService = new StorageService();

  const agentOutputsRoot = path.join(mediaRoot, 'agent-outputs');
  fs.mkdirSync(agentOutputsRoot, { recursive: true });

  // ── Agent 专用 ──

  ipcMain.handle('vp:ffmpegExecute', (_e, args) => videoService.executeFfmpeg(args));

  ipcMain.handle('vp:writeTempFile', (_e, payload: { filePath: string; content: string }) => {
    try {
      fs.mkdirSync(path.dirname(payload.filePath), { recursive: true });
      fs.writeFileSync(payload.filePath, payload.content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:ensureAgentOutputDir', (_e, payload: { dirName: string }) => {
    try {
      // 校验 dirName 无路径逃逸
      if (payload.dirName.includes('..') || payload.dirName.includes('/') || payload.dirName.includes('\\')) {
        return { absPath: '', error: 'dirName 含非法字符' };
      }
      const absPath = path.join(agentOutputsRoot, payload.dirName);
      fs.mkdirSync(absPath, { recursive: true });
      return { absPath };
    } catch (err) {
      return { absPath: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:deleteAgentOutputDir', (_e, payload: { absPath: string }) => {
    const absPath = path.resolve(payload.absPath);
    // 安全检查：必须在 agent-outputs 下
    if (!absPath.startsWith(agentOutputsRoot + path.sep)) {
      return { success: false, error: '路径越权：不在 agent-outputs 下' };
    }
    try {
      fs.rmSync(absPath, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:openInFinder', async (_e, payload: { dirPath: string }) => {
    try {
      const errorMsg = await shell.openPath(payload.dirPath);
      return { success: !errorMsg, error: errorMsg || undefined };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:fsAccess', (_e, payload: { filePath: string }) => {
    try {
      fs.accessSync(payload.filePath, fs.constants.R_OK);
      return { exists: true, readable: true };
    } catch {
      return { exists: fs.existsSync(payload.filePath), readable: false };
    }
  });

  ipcMain.handle('vp:clearAgentOutputs', () => {
    try {
      fs.rmSync(agentOutputsRoot, { recursive: true, force: true });
      fs.mkdirSync(agentOutputsRoot, { recursive: true });
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // ── 对象存储 ──

  ipcMain.handle('vp:uploadToObjectStorage', async (_e, filePath: string) => {
    try {
      return await storageService.uploadFile(filePath);
    } catch (err) {
      return { objectUrl: '', error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('vp:getStorageConfig', () => storageService.getConfig());
  ipcMain.handle('vp:saveStorageConfig', (_e, config) => {
    try {
      storageService.saveConfig(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('vp:testStorageConnection', (_e, config) => storageService.testConnection(config));

  // ── 通用 ──

  ipcMain.handle('vp:getConfig', () => modelConfigService.getLegacyModelEnginesConfig());

  ipcMain.handle('vp:pickVideoFile', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const res = await dialog.showOpenDialog(win ?? ({} as never), {
        properties: ['openFile'],
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv'] }],
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      return { canceled: false, filePath: res.filePaths[0] };
    } catch (err) {
      return { canceled: true, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('vp:prepareSource', async (_e, source) => {
    try {
      return await videoService.prepareSource(source);
    } catch (err) {
      return { preparedId: '', inputPath: '', durationSeconds: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('vp:clipSegment', (_e, args) => videoService.clipSegment(args));
  ipcMain.handle('vp:composePartVideo', (_e, args) => videoService.composePartVideo(args));
  ipcMain.handle('vp:getMediaDuration', (_e, filePath: string) => videoService.getMediaDuration(filePath));
  ipcMain.handle('vp:probeVideoQuality', (_e, filePath: string) => videoService.probeVideoQuality(filePath));
  ipcMain.handle('vp:statFile', (_e, filePath: string) => videoService.statFile(filePath));
  ipcMain.handle('vp:extractAudioFromVideo', (_e, inputPath: string) =>
    videoService.extractAudioFromVideo(inputPath),
  );

  ipcMain.handle('vp:getModelConfig', () => modelConfigService.getConfig());
  ipcMain.handle('vp:saveModelConfig', (_e, config) => {
    modelConfigService.saveConfig(config);
    return { success: true };
  });

  // ── 动态脚本工具 ──

  ipcMain.handle('vp:agentScriptTool:validate', (_e, manifest) => scriptService.validate(manifest));
  ipcMain.handle('vp:agentScriptTool:register', (_e, payload) => {
    const { manifest, runId } = payload;
    return scriptService.register(manifest, runId);
  });
  ipcMain.handle('vp:agentScriptTool:execute', (_e, request) => {
    const { name, args, runId } = request;
    return scriptService.execute(name, args, runId);
  });
  ipcMain.handle('vp:agentScriptTool:cleanup', (_e, runId: string) => {
    scriptService.cleanupRun(runId);
    return { success: true };
  });
}
