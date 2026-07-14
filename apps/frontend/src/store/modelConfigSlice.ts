import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ModelConfig, ModelPlatform } from '../types/modelConfig.js';

export interface ModelConfigState {
  config: ModelConfig;
  /** 是否已从桌面端加载 */
  loaded: boolean;
}

const initialState: ModelConfigState = {
  config: { platforms: [] },
  loaded: false,
};

const modelConfigSlice = createSlice({
  name: 'modelConfig',
  initialState,
  reducers: {
    setModelConfig(state, action: PayloadAction<ModelConfig>) {
      state.config = action.payload;
      state.loaded = true;
    },
    upsertPlatform(state, action: PayloadAction<ModelPlatform>) {
      const platform = action.payload;
      const idx = state.config.platforms.findIndex((p) => p.id === platform.id);
      if (idx >= 0) {
        state.config.platforms[idx] = platform;
      } else {
        state.config.platforms.push(platform);
      }
    },
    removePlatform(state, action: PayloadAction<string>) {
      state.config.platforms = state.config.platforms.filter((p) => p.id !== action.payload);
    },
    setPlatformModels(
      state,
      action: PayloadAction<{ platformId: string; models: string[] }>,
    ) {
      const p = state.config.platforms.find((x) => x.id === action.payload.platformId);
      if (p) p.models = action.payload.models;
    },
    setContextWindow(
      state,
      action: PayloadAction<{ platformId: string; modelName: string; contextWindow: number }>,
    ) {
      const p = state.config.platforms.find((x) => x.id === action.payload.platformId);
      if (p) {
        if (!p.contextWindows) p.contextWindows = {};
        p.contextWindows[action.payload.modelName] = action.payload.contextWindow;
      }
    },
  },
});

export const {
  setModelConfig,
  upsertPlatform,
  removePlatform,
  setPlatformModels,
  setContextWindow,
} = modelConfigSlice.actions;

export default modelConfigSlice.reducer;

export const selectModelConfig = (state: { modelConfig: ModelConfigState }): ModelConfig =>
  state.modelConfig.config;
