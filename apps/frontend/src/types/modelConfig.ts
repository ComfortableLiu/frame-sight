/** 模型配置类型。 */

/** 单模型能力标记。 */
export interface ModelCapabilities {
  audio: boolean;
  video: boolean;
  image: boolean;
  text: boolean;
}

/** 单模型设置（上下文窗口 + 能力）。 */
export interface ModelSettings {
  contextWindow?: number;
  capabilities?: ModelCapabilities;
}

export interface ModelPlatform {
  /** UUID */
  id: string;
  /** 用户自定义别名 */
  name: string;
  /** API endpoint URL */
  apiBase: string;
  apiKey: string;
  /** 同步到的全部模型列表 */
  models: string[];
  /** 用户勾选展示的模型 */
  selectedModels: string[];
  /** 各模型上下文窗口大小（token），用户设置（旧字段，兼容保留） */
  contextWindows: Record<string, number>;
  /** 各模型独立设置，key 为模型名 */
  modelSettings?: Record<string, ModelSettings>;
}

export interface ModelConfig {
  platforms: ModelPlatform[];
  /** 分析模型设置，值为 `平台名::模型名` 引用 */
  analysisModels?: {
    speech?: string;
    video?: string;
    text?: string;
  };
}

/** S3 兼容对象存储配置。 */
export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 公网访问 URL 前缀，拼接对象 key 生成可访问 URL */
  publicUrlBase: string;
  /** true 使用 path-style 寻址（MinIO 等） */
  forcePathStyle: boolean;
  /** 上传文件目录（key 前缀），留空默认 agent-outputs */
  directory: string;
}

export interface StorageConfigSnapshot {
  config?: StorageConfig;
}

export const DEFAULT_CONTEXT_WINDOW = 200000;

/** 语音合成（TTS）配置。 */
export interface VoiceSynthesisConfig {
  /** 是否启用语音合成 */
  enabled: boolean;
  /** 供应商别名（如 阿里云、火山引擎、OpenAI） */
  provider: string;
  /** API endpoint URL */
  apiBase: string;
  apiKey: string;
  /** 合成模型（如 cosyvoice-v1、tts-1） */
  model: string;
  /** 音色标识 */
  voice: string;
  /** 风格提示（可选，作为 user 消息指导合成语气/情感，如"轻快活泼、句尾上扬"） */
  style: string;
  /** 语速，0.5 ~ 2.0 */
  speed: number;
  /** 音量，0 ~ 1 */
  volume: number;
  /** 音调，0.5 ~ 2.0 */
  pitch: number;
  /** 输出音频格式（wav / mp3 / pcm） */
  format: string;
}

/** 语音识别（ASR/STT）配置。 */
export interface VoiceRecognitionConfig {
  /** 是否启用语音识别 */
  enabled: boolean;
  /** 供应商别名 */
  provider: string;
  /** API endpoint URL */
  apiBase: string;
  apiKey: string;
  /** 识别模型（如 paraformer-realtime-v2、whisper-1） */
  model: string;
  /** 识别语言（如 zh、en，留空跟随模型默认） */
  language: string;
  /** 采样率（如 16000） */
  sampleRate: number;
}

/** 语音设置快照。 */
export interface VoiceConfigSnapshot {
  synthesis?: VoiceSynthesisConfig;
  recognition?: VoiceRecognitionConfig;
}

export const DEFAULT_VOICE_SYNTHESIS: VoiceSynthesisConfig = {
  enabled: false,
  provider: '',
  apiBase: '',
  apiKey: '',
  model: '',
  voice: '',
  style: '',
  speed: 1.0,
  volume: 1.0,
  pitch: 1.0,
  format: 'wav',
};

export const DEFAULT_VOICE_RECOGNITION: VoiceRecognitionConfig = {
  enabled: false,
  provider: '',
  apiBase: '',
  apiKey: '',
  model: '',
  language: 'zh',
  sampleRate: 16000,
};
