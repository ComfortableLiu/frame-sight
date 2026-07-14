/** 模型配置类型。 */

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
  /** 各模型上下文窗口大小（token），用户设置 */
  contextWindows: Record<string, number>;
}

export interface ModelConfig {
  platforms: ModelPlatform[];
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
}

export interface StorageConfigSnapshot {
  config?: StorageConfig;
}

export const DEFAULT_CONTEXT_WINDOW = 200000;
