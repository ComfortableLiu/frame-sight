import Store from 'electron-store';
import * as crypto from 'node:crypto';

export interface ModelCapabilities {
  audio: boolean;
  video: boolean;
  image: boolean;
  text: boolean;
}

export interface ModelSettings {
  contextWindow?: number;
  capabilities?: ModelCapabilities;
}

export interface ModelPlatform {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  models: string[];
  selectedModels: string[];
  contextWindows: Record<string, number>;
  modelSettings?: Record<string, ModelSettings>;
}

export interface ModelConfig {
  platforms: ModelPlatform[];
  analysisModels?: {
    speech?: string;
    video?: string;
    text?: string;
  };
}

export interface LegacyModelEngineEntry {
  modelApiBase: string;
  modelApiKey: string;
  modelNames: string[];
}

const STORE_KEY = 'model-config';

export class ModelConfigService {
  private store: Store<{ 'model-config': ModelConfig }>;

  constructor() {
    this.store = new Store<{ 'model-config': ModelConfig }>({
      name: 'model-config',
      defaults: { 'model-config': { platforms: [] } },
    });
  }

  getConfig(): ModelConfig {
    return this.store.get(STORE_KEY, { platforms: [] });
  }

  saveConfig(config: ModelConfig): void {
    this.store.set(STORE_KEY, config);
  }

  listPlatforms(): ModelPlatform[] {
    return this.getConfig().platforms;
  }

  upsertPlatform(platform: Partial<ModelPlatform> & { name: string }): ModelPlatform {
    const config = this.getConfig();
    const existingIdx = platform.id
      ? config.platforms.findIndex((p) => p.id === platform.id)
      : -1;
    const existing = existingIdx >= 0 ? config.platforms[existingIdx] : undefined;
    const record: ModelPlatform = {
      id: platform.id ?? crypto.randomUUID(),
      name: platform.name,
      apiBase: platform.apiBase ?? '',
      apiKey: platform.apiKey ?? '',
      models: platform.models ?? [],
      selectedModels: platform.selectedModels ?? [],
      contextWindows: platform.contextWindows ?? {},
      // 透传保留 modelSettings，未提供时沿用已有值
      modelSettings: platform.modelSettings ?? existing?.modelSettings,
    };
    if (existingIdx >= 0) {
      config.platforms[existingIdx] = record;
    } else {
      config.platforms.push(record);
    }
    this.saveConfig(config);
    return record;
  }

  removePlatform(id: string): void {
    const config = this.getConfig();
    config.platforms = config.platforms.filter((p) => p.id !== id);
    this.saveConfig(config);
  }

  setContextWindow(platformId: string, modelName: string, contextWindow: number): void {
    const config = this.getConfig();
    const p = config.platforms.find((x) => x.id === platformId);
    if (!p) return;
    p.contextWindows[modelName] = contextWindow;
    this.saveConfig(config);
  }

  /** 调用平台 /models 端点同步模型列表。 */
  async syncModels(platformId: string): Promise<string[]> {
    const platform = this.getConfig().platforms.find((p) => p.id === platformId);
    if (!platform) throw new Error('平台不存在');
    const url = joinUrl(platform.apiBase, '/models');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${platform.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`同步失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const models: string[] = Array.isArray(data?.data)
      ? data.data.map((m: { id?: string }) => m.id).filter(Boolean)
      : [];
    const config = this.getConfig();
    const p = config.platforms.find((x) => x.id === platformId)!;
    p.models = models;
    this.saveConfig(config);
    return models;
  }

  async testConnection(platform: { apiBase: string; apiKey: string }): Promise<{ success: boolean; message: string; modelCount?: number }> {
    try {
      const url = joinUrl(platform.apiBase, '/models');
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${platform.apiKey}` },
      });
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      return { success: true, message: '连接成功', modelCount: count };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 兼容旧接口：Record<平台名, {modelApiBase, modelApiKey, modelNames}>。 */
  getLegacyModelEnginesConfig(): Record<string, LegacyModelEngineEntry> {
    const result: Record<string, LegacyModelEngineEntry> = {};
    for (const p of this.getConfig().platforms) {
      result[p.name] = {
        modelApiBase: p.apiBase,
        modelApiKey: p.apiKey,
        modelNames: p.selectedModels.length ? p.selectedModels : p.models,
      };
    }
    return result;
  }
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}
