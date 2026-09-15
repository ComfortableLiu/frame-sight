import { createSlice, createSelector, type PayloadAction } from '@reduxjs/toolkit';
import type { ScriptPart } from '../types/script.js';
import { segmentKey, voiceKey } from '../types/script.js';

export type FlowMode = 'normal' | 'agent';

export type SegmentStatus = 'idle' | 'clipping' | 'done' | 'error';
export type VoiceStatus = 'idle' | 'generating' | 'done' | 'error';

export interface CommentarySegmentState {
  partNumber: number;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  status: SegmentStatus;
  outputPath?: string;
  segmentUrl?: string;
  error?: string;
  removeBackgroundAudio?: boolean;
  mergedOutputPath?: string;
  mergedUrl?: string;
  mergedBaseOutputPath?: string;
  mergedBaseUrl?: string;
  sourceStartMs?: number;
  sourceEndMs?: number;
}

export interface CommentaryVoiceState {
  partNumber: number;
  segmentIndex: number;
  text: string;
  voiceId: string;
  speed: number;
  status: VoiceStatus;
  outputPath?: string;
  audioUrl?: string;
  version?: number;
  error?: string;
}

export interface VoiceSettings {
  voiceId: string;
  speed: number;
}

export interface SubtitleSettings {
  marginV: number;
  fontSize: number;
  fontColor: string;
  bold: boolean;
  outlineEnabled: boolean;
  outlineSize: number;
  outlineColor: string;
}

export interface ComposeAudioSettings {
  backgroundMusicPath: string;
  backgroundMusicUrl: string;
  backgroundMusicVolume: number;
  originalClipVolume: number;
  keepVocals: boolean;
  vocalIsolationMix: number;
  vocalIsolationBackend: 'ffmpeg' | 'demucs';
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkOpacity: number;
  watermarkFontSize: number;
  forcedAspectRatio: 'source' | '16:9' | '4:3' | '9:16' | '3:4';
  finalVideoBitrateKbps: number;
}

export interface Step6TextItem {
  id: string;
  text: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  bold: boolean;
  xPercent: number;
  yPercent: number;
  fontFamily: string;
}

export interface Step6ComposeConfig {
  coverImagePath: string;
  coverImageUrl: string;
  forcePortrait: boolean;
  texts: Step6TextItem[];
}

export interface Step6Preset {
  id: string;
  alias: string;
  config: Step6ComposeConfig;
}

export interface Step7AdConfig {
  insertionTimeSec: number;
  direction: string;
  bridgeText: string;
  adText: string;
  ttsSpeed: number;
  voiceId: string;
  adVoicePath?: string;
  adVoiceUrl?: string;
  adVoiceDurationSec?: number;
  llmTargetBusiness?: string;
  llmTriggerSentence?: string;
  llmRationale?: string;
  llmSourceVideoHttpUrl?: string;
}

export interface AdVideoItem {
  id: string;
  name: string;
  description: string;
  filePath: string;
  previewUrl: string;
}

export interface OutputPart {
  outputPath: string;
  finalUrl: string;
}

export interface CommentaryLlmModels {
  step1SrtModel: string;
  step1StructuredReportModel: string;
  step1PlotBreakdownModel: string;
  step1MainScriptModel: string;
  step1GoldenHookModel: string;
  step7AdModel: string;
}

export interface ComposeProgressState {
  active: boolean;
  status: 'idle' | 'running' | 'cancelled' | 'done' | 'error';
  step?: string;
  processed?: number;
  total?: number;
  partNumber?: number;
  detail?: string;
  ratio?: number;
}

export interface CommentaryState {
  flowMode: FlowMode;
  localVideoPath: string;
  preparedId: string;
  inputPath: string;
  sourceUrl: string;
  localVideoDurationSeconds: number | null;
  structuredReport: string;
  structuredReportSourceVideoLink: string;
  step1SrtText: string;
  script: ScriptPart[] | string;
  streamingScriptText: string;
  segments: Record<string, CommentarySegmentState>;
  voices: Record<string, CommentaryVoiceState>;
  voiceSettings: VoiceSettings;
  subtitleSettings: SubtitleSettings;
  composeAudioSettings: ComposeAudioSettings;
  commentaryRatioCommentary: number;
  commentaryRatioOriginal: number;
  commentaryMaxSeconds: number;
  mediaContentScope: string;
  finalParts: Record<string, OutputPart>;
  step6Configs: Record<string, Step6ComposeConfig>;
  step6Outputs: Record<string, OutputPart>;
  step6PresetHistory: Step6Preset[];
  step6SelectedPresetId: string;
  step7Configs: Record<string, Step7AdConfig>;
  step7Outputs: Record<string, OutputPart>;
  adVideos: AdVideoItem[];
  llmModels: CommentaryLlmModels;
  currentStep: number;
  watermarkHistory: Array<{ text: string; opacity: number; fontSize: number }>;
  compressForUploadEnabled: boolean;
  compressResolutionKey: '1080p' | '720p' | '540p' | '360p';
  compressFps: number;
  compressBitrateKbps: number;
  isGeneratingScript: boolean;
  scriptGenerateProgress: string;
  quickGenerateRunning: boolean;
  quickGenerateProgress: number;
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  marginV: 30,
  fontSize: 28,
  fontColor: '#FFFFFF',
  bold: false,
  outlineEnabled: true,
  outlineSize: 2,
  outlineColor: '#000000',
};

export const DEFAULT_COMPOSE_AUDIO: ComposeAudioSettings = {
  backgroundMusicPath: '',
  backgroundMusicUrl: '',
  backgroundMusicVolume: 0.6,
  originalClipVolume: 0.5,
  keepVocals: false,
  vocalIsolationMix: 0.35,
  vocalIsolationBackend: 'ffmpeg',
  watermarkEnabled: false,
  watermarkText: '',
  watermarkOpacity: 0.2,
  watermarkFontSize: 26,
  forcedAspectRatio: 'source',
  finalVideoBitrateKbps: 3000,
};

const initialState: CommentaryState = {
  flowMode: 'normal',
  localVideoPath: '',
  preparedId: '',
  inputPath: '',
  sourceUrl: '',
  localVideoDurationSeconds: null,
  structuredReport: '',
  structuredReportSourceVideoLink: '',
  step1SrtText: '',
  script: [],
  streamingScriptText: '',
  segments: {},
  voices: {},
  voiceSettings: { voiceId: '', speed: 1 },
  subtitleSettings: { ...DEFAULT_SUBTITLE_SETTINGS },
  composeAudioSettings: { ...DEFAULT_COMPOSE_AUDIO },
  commentaryRatioCommentary: 1,
  commentaryRatioOriginal: 2,
  commentaryMaxSeconds: 7,
  mediaContentScope: '',
  finalParts: {},
  step6Configs: {},
  step6Outputs: {},
  step6PresetHistory: [],
  step6SelectedPresetId: '',
  step7Configs: {},
  step7Outputs: {},
  adVideos: [],
  llmModels: {
    step1SrtModel: '',
    step1StructuredReportModel: '',
    step1PlotBreakdownModel: '',
    step1MainScriptModel: '',
    step1GoldenHookModel: '',
    step7AdModel: '',
  },
  currentStep: 1,
  watermarkHistory: [],
  compressForUploadEnabled: true,
  compressResolutionKey: '360p',
  compressFps: 30,
  compressBitrateKbps: 900,
  isGeneratingScript: false,
  scriptGenerateProgress: '',
  quickGenerateRunning: false,
  quickGenerateProgress: 0,
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function computeMaxAllowedStep(s: CommentaryState): number {
  const hasVideo = Boolean(s.preparedId || s.localVideoPath);
  if (!hasVideo) return 1;
  const hasScript =
    (Array.isArray(s.script) && s.script.length > 0) ||
    (typeof s.script === 'string' && s.script.trim().length > 0);
  if (!hasScript) return 1;
  const segs = Object.values(s.segments);
  const hasClip = segs.some((x) => x.status === 'done' && x.outputPath);
  if (!hasClip) return 2;
  const voices = Object.values(s.voices);
  const hasVoice = voices.some((x) => x.status === 'done' && x.outputPath);
  if (!hasVoice) return 3;
  const hasMerged = segs.some((x) => x.mergedOutputPath);
  if (!hasMerged) return 4;
  const hasFinal = Object.values(s.finalParts).some((x) => x.outputPath);
  if (!hasFinal) return 5;
  const hasStep6 = Object.values(s.step6Outputs).some((x) => x.outputPath);
  if (!hasStep6) return 6;
  return 7;
}

const commentarySlice = createSlice({
  name: 'commentary',
  initialState,
  reducers: {
    setFlowMode(state, action: PayloadAction<FlowMode>) {
      state.flowMode = action.payload;
    },
    setLocalVideo(
      state,
      action: PayloadAction<{
        localVideoPath: string;
        preparedId?: string;
        inputPath?: string;
        sourceUrl?: string;
        durationSeconds?: number | null;
      }>,
    ) {
      const p = action.payload;
      const identityChanged = state.localVideoPath && state.localVideoPath !== p.localVideoPath;
      state.localVideoPath = p.localVideoPath;
      if (p.preparedId != null) state.preparedId = p.preparedId;
      if (p.inputPath != null) state.inputPath = p.inputPath;
      if (p.sourceUrl != null) state.sourceUrl = p.sourceUrl;
      if (p.durationSeconds !== undefined) state.localVideoDurationSeconds = p.durationSeconds;
      if (identityChanged) {
        state.structuredReport = '';
        state.structuredReportSourceVideoLink = '';
        state.step1SrtText = '';
        state.script = [];
        state.streamingScriptText = '';
        state.segments = {};
        state.voices = {};
        state.finalParts = {};
        state.step6Outputs = {};
        state.step7Outputs = {};
        state.currentStep = 1;
      }
    },
    setPreparedSource(
      state,
      action: PayloadAction<{
        preparedId: string;
        inputPath: string;
        sourceUrl: string;
        durationSeconds?: number | null;
      }>,
    ) {
      state.preparedId = action.payload.preparedId;
      state.inputPath = action.payload.inputPath;
      state.sourceUrl = action.payload.sourceUrl;
      if (action.payload.durationSeconds != null) {
        state.localVideoDurationSeconds = action.payload.durationSeconds;
      }
    },
    setStructuredReport(state, action: PayloadAction<{ report: string; sourceLink: string }>) {
      state.structuredReport = action.payload.report;
      state.structuredReportSourceVideoLink = action.payload.sourceLink;
    },
    setStep1Srt(state, action: PayloadAction<string>) {
      state.step1SrtText = action.payload;
    },
    setScript(state, action: PayloadAction<ScriptPart[]>) {
      state.script = action.payload;
    },
    setStreamingScriptText(state, action: PayloadAction<string>) {
      state.streamingScriptText = action.payload;
    },
    setScriptGenerating(state, action: PayloadAction<{ running: boolean; progress?: string }>) {
      state.isGeneratingScript = action.payload.running;
      if (action.payload.progress != null) state.scriptGenerateProgress = action.payload.progress;
    },
    upsertSegment(
      state,
      action: PayloadAction<{ key: string; value: Partial<CommentarySegmentState> & { partNumber: number; segmentIndex: number } }>,
    ) {
      const { key, value } = action.payload;
      const prev = state.segments[key];
      state.segments[key] = Object.assign(
        { startMs: 0, endMs: 0, status: 'idle' as SegmentStatus },
        prev,
        value,
      );
    },
    patchSegment(
      state,
      action: PayloadAction<{
        key: string;
        patch: Partial<CommentarySegmentState>;
        invalidateDownstream?: boolean;
      }>,
    ) {
      const { key, patch, invalidateDownstream = true } = action.payload;
      const seg = state.segments[key];
      if (!seg) return;
      Object.assign(seg, patch);
      if (invalidateDownstream && (patch.startMs != null || patch.endMs != null)) {
        // 时间变更时清空裁剪与合并产物
        if (patch.outputPath === undefined) {
          delete seg.outputPath;
          delete seg.segmentUrl;
        }
        delete seg.mergedOutputPath;
        delete seg.mergedUrl;
        delete seg.mergedBaseOutputPath;
        delete seg.mergedBaseUrl;
        if (seg.status === 'done') seg.status = 'idle';
      }
    },
    upsertVoice(
      state,
      action: PayloadAction<{
        key: string;
        value: Partial<CommentaryVoiceState> & { partNumber: number; segmentIndex: number };
      }>,
    ) {
      const { key, value } = action.payload;
      const prev = state.voices[key];
      state.voices[key] = Object.assign(
        {
          text: '',
          voiceId: state.voiceSettings.voiceId,
          speed: state.voiceSettings.speed,
          status: 'idle' as VoiceStatus,
        },
        prev,
        value,
      );
    },
    patchVoice(state, action: PayloadAction<{ key: string; patch: Partial<CommentaryVoiceState> }>) {
      const { key, patch } = action.payload;
      const v = state.voices[key];
      if (!v) return;
      Object.assign(v, patch);
    },
    setVoiceSettings(state, action: PayloadAction<Partial<VoiceSettings>>) {
      Object.assign(state.voiceSettings, action.payload);
    },
    setSubtitleSettings(state, action: PayloadAction<Partial<SubtitleSettings>>) {
      Object.assign(state.subtitleSettings, action.payload);
    },
    setComposeAudioSettings(state, action: PayloadAction<Partial<ComposeAudioSettings>>) {
      Object.assign(state.composeAudioSettings, action.payload);
      if (!state.composeAudioSettings.backgroundMusicPath) {
        state.composeAudioSettings.keepVocals = false;
      }
    },
    addWatermarkHistory(state, action: PayloadAction<{ text: string; opacity: number; fontSize: number }>) {
      const item = action.payload;
      const key = `${item.text}__${item.opacity}__${item.fontSize}`;
      state.watermarkHistory = [
        item,
        ...state.watermarkHistory.filter(
          (h) => `${h.text}__${h.opacity}__${h.fontSize}` !== key,
        ),
      ].slice(0, 20);
    },
    removeWatermarkHistory(state, action: PayloadAction<number>) {
      state.watermarkHistory.splice(action.payload, 1);
    },
    setFinalPart(state, action: PayloadAction<{ partNumber: number | string; outputPath: string; finalUrl: string }>) {
      const { partNumber, outputPath, finalUrl } = action.payload;
      state.finalParts[String(partNumber)] = { outputPath, finalUrl };
    },
    setStep6Config(state, action: PayloadAction<{ partNumber: number | string; patch: Partial<Step6ComposeConfig> }>) {
      const pn = String(action.payload.partNumber);
      const prev =
        state.step6Configs[pn] ??
        ({ coverImagePath: '', coverImageUrl: '', forcePortrait: true, texts: [] } satisfies Step6ComposeConfig);
      state.step6Configs[pn] = { ...prev, ...action.payload.patch };
    },
    setStep6Output(state, action: PayloadAction<{ partNumber: number | string; outputPath: string; finalUrl: string }>) {
      const { partNumber, outputPath, finalUrl } = action.payload;
      state.step6Outputs[String(partNumber)] = { outputPath, finalUrl };
    },
    upsertStep6Preset(state, action: PayloadAction<{ id?: string; alias: string; config: Step6ComposeConfig }>) {
      const { id, alias, config } = action.payload;
      if (id) {
        const idx = state.step6PresetHistory.findIndex((p) => p.id === id);
        if (idx >= 0) {
          state.step6PresetHistory[idx] = { id, alias, config };
          return;
        }
      }
      const newId = id || `p_${Date.now()}`;
      state.step6PresetHistory.unshift({ id: newId, alias, config });
    },
    removeStep6Preset(state, action: PayloadAction<string>) {
      state.step6PresetHistory = state.step6PresetHistory.filter((p) => p.id !== action.payload);
      if (state.step6SelectedPresetId === action.payload) state.step6SelectedPresetId = '';
    },
    setStep6SelectedPresetId(state, action: PayloadAction<string>) {
      state.step6SelectedPresetId = action.payload;
    },
    setStep7Config(state, action: PayloadAction<{ partNumber: number | string; patch: Partial<Step7AdConfig> }>) {
      const pn = String(action.payload.partNumber);
      const prev =
        state.step7Configs[pn] ??
        ({
          insertionTimeSec: 0,
          direction: '',
          bridgeText: '',
          adText: '',
          ttsSpeed: 1,
          voiceId: '',
        } satisfies Step7AdConfig);
      state.step7Configs[pn] = { ...prev, ...action.payload.patch };
    },
    setStep7Output(state, action: PayloadAction<{ partNumber: number | string; outputPath: string; finalUrl: string }>) {
      const { partNumber, outputPath, finalUrl } = action.payload;
      state.step7Outputs[String(partNumber)] = { outputPath, finalUrl };
    },
    setAdVideos(state, action: PayloadAction<AdVideoItem[]>) {
      state.adVideos = action.payload;
    },
    setLlmModel(state, action: PayloadAction<{ key: keyof CommentaryLlmModels; value: string }>) {
      state.llmModels[action.payload.key] = action.payload.value;
    },
    setCurrentStep(state, action: PayloadAction<number>) {
      const max = computeMaxAllowedStep(state);
      state.currentStep = clamp(action.payload, 1, Math.max(1, max));
    },
    setCommentaryParams(
      state,
      action: PayloadAction<{
        commentaryRatioCommentary?: number;
        commentaryRatioOriginal?: number;
        commentaryMaxSeconds?: number;
        mediaContentScope?: string;
      }>,
    ) {
      const p = action.payload;
      if (p.commentaryRatioCommentary != null) state.commentaryRatioCommentary = p.commentaryRatioCommentary;
      if (p.commentaryRatioOriginal != null) state.commentaryRatioOriginal = p.commentaryRatioOriginal;
      if (p.commentaryMaxSeconds != null) state.commentaryMaxSeconds = p.commentaryMaxSeconds;
      if (p.mediaContentScope != null) state.mediaContentScope = p.mediaContentScope;
    },
    setCompressSettings(
      state,
      action: PayloadAction<{
        compressForUploadEnabled?: boolean;
        compressResolutionKey?: CommentaryState['compressResolutionKey'];
        compressFps?: number;
        compressBitrateKbps?: number;
      }>,
    ) {
      Object.assign(state, action.payload);
    },
    setQuickGenerate(state, action: PayloadAction<{ running: boolean; progress?: number }>) {
      state.quickGenerateRunning = action.payload.running;
      if (action.payload.progress != null) state.quickGenerateProgress = action.payload.progress;
    },
    restoreCommentaryState(state, action: PayloadAction<Partial<CommentaryState>>) {
      const incoming = action.payload || {};
      const merged: CommentaryState = { ...initialState, ...incoming };
      // 清洗中间态
      for (const seg of Object.values(merged.segments)) {
        if (seg.status === 'clipping') seg.status = 'idle';
      }
      for (const v of Object.values(merged.voices)) {
        if (v.status === 'generating') v.status = 'idle';
      }
      merged.composeAudioSettings = {
        ...DEFAULT_COMPOSE_AUDIO,
        ...(incoming.composeAudioSettings || {}),
      };
      if (!merged.composeAudioSettings.backgroundMusicPath) {
        merged.composeAudioSettings.keepVocals = false;
      }
      merged.subtitleSettings = {
        ...DEFAULT_SUBTITLE_SETTINGS,
        ...(incoming.subtitleSettings || {}),
      };
      Object.assign(state, merged);
      state.isGeneratingScript = false;
      state.quickGenerateRunning = false;
    },
    resetCommentary() {
      return { ...initialState };
    },
  },
});

export const {
  setFlowMode,
  setLocalVideo,
  setPreparedSource,
  setStructuredReport,
  setStep1Srt,
  setScript,
  setStreamingScriptText,
  setScriptGenerating,
  upsertSegment,
  patchSegment,
  upsertVoice,
  patchVoice,
  setVoiceSettings,
  setSubtitleSettings,
  setComposeAudioSettings,
  addWatermarkHistory,
  removeWatermarkHistory,
  setFinalPart,
  setStep6Config,
  setStep6Output,
  upsertStep6Preset,
  removeStep6Preset,
  setStep6SelectedPresetId,
  setStep7Config,
  setStep7Output,
  setAdVideos,
  setLlmModel,
  setCurrentStep,
  setCommentaryParams,
  setCompressSettings,
  setQuickGenerate,
  restoreCommentaryState,
  resetCommentary,
} = commentarySlice.actions;

export default commentarySlice.reducer;

export const selectCommentary = (s: { commentary: CommentaryState }) => s.commentary;
export const selectFlowMode = createSelector(selectCommentary, (c) => c.flowMode);
export const selectCurrentStep = createSelector(selectCommentary, (c) => c.currentStep);
export const selectMaxAllowedStep = createSelector(selectCommentary, (c) =>
  Math.max(computeMaxAllowedStep(c), 1),
);
export const selectScriptParts = createSelector(selectCommentary, (c): ScriptPart[] => {
  if (Array.isArray(c.script)) return c.script;
  return [];
});
export const selectSegments = createSelector(selectCommentary, (c) => c.segments);
export const selectVoices = createSelector(selectCommentary, (c) => c.voices);
export const selectAdVideos = createSelector(selectCommentary, (c) => c.adVideos);
export const selectPreparedId = createSelector(selectCommentary, (c) => c.preparedId);
export const selectInputPath = createSelector(selectCommentary, (c) => c.inputPath || c.localVideoPath);

export { segmentKey, voiceKey };
