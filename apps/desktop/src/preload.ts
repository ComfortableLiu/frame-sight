import { contextBridge, ipcRenderer } from 'electron';

/**
 * 通过 contextBridge 暴露所有 vp:* API 给渲染进程。
 */
const api = {
  // ── Agent 专用 ──
  ffmpegExecute: (args: unknown) => ipcRenderer.invoke('vp:ffmpegExecute', args),
  writeTempFile: (payload: unknown) => ipcRenderer.invoke('vp:writeTempFile', payload),
  ensureAgentOutputDir: (payload: unknown) => ipcRenderer.invoke('vp:ensureAgentOutputDir', payload),
  deleteAgentOutputDir: (payload: unknown) => ipcRenderer.invoke('vp:deleteAgentOutputDir', payload),
  openInFinder: (payload: unknown) => ipcRenderer.invoke('vp:openInFinder', payload),
  fsAccess: (payload: unknown) => ipcRenderer.invoke('vp:fsAccess', payload),
  clearAgentOutputs: () => ipcRenderer.invoke('vp:clearAgentOutputs'),

  // ── 对象存储 ──
  uploadToObjectStorage: (filePath: string) => ipcRenderer.invoke('vp:uploadToObjectStorage', filePath),
  getStorageConfig: () => ipcRenderer.invoke('vp:getStorageConfig'),
  saveStorageConfig: (config: unknown) => ipcRenderer.invoke('vp:saveStorageConfig', config),
  testStorageConnection: (config: unknown) => ipcRenderer.invoke('vp:testStorageConnection', config),

  // ── 通用 ──
  getConfig: () => ipcRenderer.invoke('vp:getConfig'),
  pickVideoFile: () => ipcRenderer.invoke('vp:pickVideoFile'),
  prepareSource: (source: unknown) => ipcRenderer.invoke('vp:prepareSource', source),
  clipSegment: (args: unknown) => ipcRenderer.invoke('vp:clipSegment', args),
  composePartVideo: (args: unknown) => ipcRenderer.invoke('vp:composePartVideo', args),
  getMediaDuration: (filePath: string) => ipcRenderer.invoke('vp:getMediaDuration', filePath),
  probeVideoQuality: (filePath: string) => ipcRenderer.invoke('vp:probeVideoQuality', filePath),
  statFile: (filePath: string) => ipcRenderer.invoke('vp:statFile', filePath),
  extractAudioFromVideo: (inputPath: string) => ipcRenderer.invoke('vp:extractAudioFromVideo', inputPath),
  getModelConfig: () => ipcRenderer.invoke('vp:getModelConfig'),
  saveModelConfig: (config: unknown) => ipcRenderer.invoke('vp:saveModelConfig', config),

  // ── 动态脚本工具 ──
  agentScriptToolValidate: (manifest: unknown) => ipcRenderer.invoke('vp:agentScriptTool:validate', manifest),
  agentScriptToolRegister: (payload: unknown) => ipcRenderer.invoke('vp:agentScriptTool:register', payload),
  agentScriptToolExecute: (request: unknown) => ipcRenderer.invoke('vp:agentScriptTool:execute', request),
  agentScriptToolCleanup: (runId: string) => ipcRenderer.invoke('vp:agentScriptTool:cleanup', runId),
};

contextBridge.exposeInMainWorld('viewPoint', api);

export type ViewPointApi = typeof api;
