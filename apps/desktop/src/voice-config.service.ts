import Store from 'electron-store';
import { safeStorage } from 'electron';

export interface VoiceSynthesisConfig {
  enabled: boolean;
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  voice: string;
  style: string;
  speed: number;
  volume: number;
  pitch: number;
  format: string;
}

export interface VoiceRecognitionConfig {
  enabled: boolean;
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  language: string;
  sampleRate: number;
}

export interface VoiceConfigSnapshot {
  synthesis?: VoiceSynthesisConfig;
  recognition?: VoiceRecognitionConfig;
}

interface StoredConfig {
  synthesis?: VoiceSynthesisConfig;
  recognition?: VoiceRecognitionConfig;
}

/** 语音合成 / 语音识别设置持久化，apiKey 明文存储。 */
export class VoiceConfigService {
  private store: Store<StoredConfig>;

  constructor() {
    this.store = new Store<StoredConfig>({
      name: 'voice-config',
      defaults: {},
    });
  }

  getConfig(): VoiceConfigSnapshot {
    const raw = this.store.store;
    return {
      synthesis: raw.synthesis ? this.migrate(raw.synthesis, 'synthesis') : undefined,
      recognition: raw.recognition ? this.migrate(raw.recognition, 'recognition') : undefined,
    };
  }

  saveConfig(config: VoiceConfigSnapshot): void {
    const toStore: StoredConfig = {};
    if (config.synthesis) toStore.synthesis = config.synthesis;
    if (config.recognition) toStore.recognition = config.recognition;
    this.store.store = toStore;
  }

  /**
   * 兼容旧版本遗留的密文 apiKey：尝试按 base64 + safeStorage 解密，
   * 成功则以明文重新落盘；失败说明本来就是明文，原样使用。
   */
  private migrate<T extends { apiKey: string }>(config: T, key: keyof StoredConfig): T {
    if (!config.apiKey) return config;
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(config.apiKey, 'base64'));
      if (!decrypted) return config;
      const migrated = { ...config, apiKey: decrypted };
      this.store.set(key, migrated);
      return migrated;
    } catch {
      // 解密失败：按明文原样使用
      return config;
    }
  }
}
