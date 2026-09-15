/**
 * window.viewPoint 类型声明 —— 渲染进程通过 contextBridge 访问的桌面端 API。
 */

export interface FfmpegExecuteArgs {
  /** ffmpeg 参数数组，如 ['-i', 'in.mp4', 'out.mp4'] */
  args: string[];
  /** 工作目录（可选） */
  cwd?: string;
}

export interface FfmpegExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  outputPath?: string;
}

export interface PreparedSource {
  preparedId: string;
  inputPath: string;
  durationSeconds: number | null;
}

export interface ClipSegmentArgs {
  inputPath: string;
  startMs: number;
  endMs: number;
  outputPath: string;
  originalClipVolume?: number;
}

export interface ComposePartVideoArgs {
  segments: Array<{ clipPath: string; startMs: number; endMs: number }>;
  outputPath: string;
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

export interface ModelEnginesLegacyEntry {
  modelApiBase: string;
  modelApiKey: string;
  modelNames: string[];
}

export interface AgentScriptToolManifest {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  source: string;
}

export interface AgentScriptToolValidationResult {
  valid: boolean;
  errors: string[];
  blockedRules: string[];
}

export interface AgentScriptToolRegisterPayload {
  manifest: AgentScriptToolManifest;
  runId: string;
}

export interface AgentScriptToolExecuteRequest {
  name: string;
  args: Record<string, unknown>;
  runId: string;
}

export interface AgentScriptToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  audit?: {
    outputFiles: string[];
    durationMs: number;
  };
}

export interface DynamicToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ViewPointApi {
  // ── Agent 专用 ──
  ffmpegExecute: (args: FfmpegExecuteArgs) => Promise<FfmpegExecuteResult>;
  writeTempFile: (payload: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }>;
  ensureAgentOutputDir: (payload: { dirName: string }) => Promise<{ absPath: string }>;
  deleteAgentOutputDir: (payload: { absPath: string }) => Promise<{ success: boolean; error?: string }>;
  openInFinder: (payload: { dirPath: string }) => Promise<void>;
  fsAccess: (payload: { filePath: string }) => Promise<{ exists: boolean; readable: boolean }>;
  clearAgentOutputs: () => Promise<{ success: boolean }>;

  // ── 对象存储 ──
  uploadToObjectStorage: (filePath: string) => Promise<{ objectUrl: string; error?: string }>;
  getStorageConfig: () => Promise<StorageConfigSnapshot>;
  saveStorageConfig: (config: StorageConfig) => Promise<{ success: boolean; error?: string }>;
  testStorageConnection: (config: StorageConfig) => Promise<{ success: boolean; message: string; modelCount?: number }>;

  // ── 报告缓存 / 临时文件 ──
  getReportCache: (payload: { filePath: string; size: number }) => Promise<{ hit: boolean; srt?: string; report?: string; createdAt?: number }>;
  saveReportCache: (payload: { filePath: string; size: number; srt: string; report: string }) => Promise<{ success: boolean; error?: string }>;
  getSrtCache: (payload: { filePath: string; size: number }) => Promise<{ hit: boolean; srt?: string }>;
  saveSrtCache: (payload: { filePath: string; size: number; srt: string }) => Promise<{ success: boolean; error?: string }>;
  clearReportCache: (payload: { filePath: string; size: number }) => Promise<{ success: boolean; error?: string }>;
  deleteFile: (payload: { filePath: string }) => Promise<{ success: boolean; error?: string }>;

  // ── 通用 ──
  getConfig: () => Promise<Record<string, ModelEnginesLegacyEntry>>;
  pickVideoFile: () => Promise<{ canceled: boolean; filePath?: string }>;
  prepareSource: (source: { filePath: string }) => Promise<PreparedSource>;
  clipSegment: (args: ClipSegmentArgs) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  composePartVideo: (args: ComposePartVideoArgs) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  getMediaDuration: (filePath: string) => Promise<number | null>;
  probeVideoQuality: (filePath: string) => Promise<VideoInfo>;
  statFile: (filePath: string) => Promise<{ size: number | null; exists: boolean }>;
  extractAudioFromVideo: (inputPath: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  readFileAsBase64: (filePath: string) => Promise<{ success: boolean; base64?: string; size?: number; error?: string }>;
  writeBase64File: (payload: { filePath: string; base64: string }) => Promise<{ success: boolean; outputPath?: string; size?: number; error?: string }>;
  getModelConfig: () => Promise<ModelConfig>;
  saveModelConfig: (config: ModelConfig) => Promise<{ success: boolean; error?: string }>;

  // ── 语音合成 / 语音识别 ──
  getVoiceConfig: () => Promise<VoiceConfigSnapshot>;
  saveVoiceConfig: (config: VoiceConfigSnapshot) => Promise<{ success: boolean; error?: string }>;

  // ── 动态脚本工具 ──
  agentScriptToolValidate: (manifest: AgentScriptToolManifest) => Promise<AgentScriptToolValidationResult>;
  agentScriptToolRegister: (payload: AgentScriptToolRegisterPayload) => Promise<{ success: boolean; error?: string; tool?: DynamicToolDescriptor }>;
  agentScriptToolExecute: (request: AgentScriptToolExecuteRequest) => Promise<AgentScriptToolExecutionResult>;
  agentScriptToolCleanup: (runId: string) => Promise<{ success: boolean }>;

  // ── 影视解说模式 ──
  pickImageFile: () => Promise<{ canceled: boolean; filePath?: string; previewUrl?: string; error?: string }>;
  pickAudioFile: () => Promise<{ canceled: boolean; filePath?: string; previewUrl?: string; error?: string }>;
  getImagePreviewUrl: (filePath: string) => Promise<{ previewUrl?: string; error?: string }>;
  probeSourcePreview: (input: { filePath: string }) => Promise<Record<string, unknown> & { error?: string }>;
  prepareSourceEx: (input: { filePath: string }) => Promise<{
    preparedId: string;
    inputPath: string;
    sourceUrl: string;
    durationSeconds: number | null;
    error?: string;
  }>;
  clipSegmentEx: (args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    startMs: number;
    endMs: number;
    inputPath?: string;
  }) => Promise<{ outputPath: string; segmentUrl: string; durationSeconds: number }>;
  mergeSegmentWithVoice: (args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    segmentPath: string;
    voicePath: string;
    inputPath: string;
    startMs: number;
  }) => Promise<{ outputPath: string; outputUrl: string }>;
  burnSubtitles: (args: {
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
  }) => Promise<{ outputPath: string; url: string; srtPath: string }>;
  getMediaDurationSeconds: (filePath: string) => Promise<{ durationSeconds: number }>;
  extractAudioToWav: (inputPath: string) => Promise<{ outputPath: string }>;
  compressVideoForUpload: (args: {
    inputPath: string;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  }) => Promise<{ outputPath: string }>;
  changeAudioSpeed: (args: { inputPath: string; speed: number; outputPath: string }) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
  composePartVideoEx: (args: {
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
  }) => Promise<{ outputPath: string; finalUrl: string }>;
  composeProgressStatus: () => Promise<{
    active: boolean;
    status: string;
    step?: string;
    processed?: number;
    total?: number;
    partNumber?: number;
    detail?: string;
    ratio?: number;
  }>;
  composeProgressCancel: () => Promise<{ ok: boolean }>;
  composeCoverVideo: (args: {
    inputPath: string;
    coverImagePath?: string;
    coverDurationSec?: number;
    forcePortrait?: boolean;
    videoBitrateKbps?: number;
    texts: Array<Record<string, unknown> & { text: string }>;
  }) => Promise<{ outputPath: string; finalUrl: string }>;
  composeAdVideo: (args: {
    inputPath: string;
    adVideoPath: string;
    adAudioPath: string;
    insertionTimeSec: number;
    videoBitrateKbps?: number;
  }) => Promise<{ outputPath: string; finalUrl: string }>;
  previewVocalIsolation: (args: { inputVideoPath: string; vocalIsolationMix: number }) => Promise<{ previewUrl: string }>;
  exportPartVideo: (payload: { outputPath: string; defaultFileName?: string }) => Promise<{ canceled: boolean; outputPath?: string }>;
  exportAllVideos: (payload: { items: Array<{ outputPath: string; fileName: string }> }) => Promise<{ canceled: boolean; dir?: string }>;
  adVideosList: () => Promise<{ items: Array<{ id: string; name: string; description: string; filePath: string; previewUrl: string }> }>;
  adVideosAdd: (payload: { name: string; description: string; filePath: string }) => Promise<{ ok: boolean; id?: string }>;
  adVideosUpdate: (payload: { id: string; name: string; description: string }) => Promise<{ ok: boolean }>;
  adVideosDelete: (id: string) => Promise<{ ok: boolean }>;
  listCustomFonts: () => Promise<{ items: Array<{ id: string; alias: string; filePath: string; previewUrl: string }> }>;
  generateVoice: (args: {
    preparedId: string;
    partNumber: number | string;
    segmentIndex: number;
    text: string;
    voiceId?: string;
    speed?: number;
  }) => Promise<{ outputPath: string; audioUrl: string }>;
  uploadCommentaryMedia: (filePath: string) => Promise<{ url: string; error?: string }>;
  resolveLocalMedia: (token: string) => Promise<{ absPath: string }>;
  saveCommentaryFile: (payload: { relPath: string; content: string }) => Promise<{ success: boolean; absPath?: string; error?: string }>;
}

// 引入用于类型声明
import type { ModelConfig, StorageConfig, StorageConfigSnapshot, ModelEnginesLegacyEntry, VoiceConfigSnapshot } from './modelConfig';

declare global {
  interface Window {
    viewPoint: ViewPointApi;
  }
}

export {};
