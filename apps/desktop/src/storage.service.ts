import Store from 'electron-store';
import * as path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrlBase: string;
  forcePathStyle: boolean;
}

export interface StorageSnapshot {
  config?: StorageConfig;
}

export class StorageService {
  private store: Store<{ config: StorageConfig | undefined }>;
  private clientCache: S3Client | null = null;
  private cachedKey = '';

  constructor() {
    this.store = new Store<{ config: StorageConfig | undefined }>({
      name: 'storage-config',
      defaults: { config: undefined },
    });
  }

  getConfig(): StorageSnapshot {
    return { config: this.store.get('config') };
  }

  saveConfig(config: StorageConfig): void {
    this.store.set('config', config);
    this.clientCache = null;
  }

  private getClient(): S3Client {
    const config = this.store.get('config');
    if (!config) throw new Error('未配置对象存储，请先在设置中配置');
    // key 包含所有配置字段，改 bucket/密钥/style 时重建 client
    const key = `${config.endpoint}|${config.region}|${config.bucket}|${config.accessKeyId}|${config.forcePathStyle}`;
    if (this.clientCache && this.cachedKey === key) return this.clientCache;
    this.clientCache = new S3Client({
      endpoint: config.endpoint || undefined,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
    this.cachedKey = key;
    return this.clientCache;
  }

  /**
   * 上传文件，返回可访问 URL。
   * 优先 publicUrlBase 拼接；私有 bucket 回退预签名 URL。
   * 未配置时返回 { objectUrl: '', error } 而非抛出。
   */
  async uploadFile(filePath: string): Promise<{ objectUrl: string; error?: string }> {
    const config = this.store.get('config');
    if (!config) return { objectUrl: '', error: '未配置对象存储，请先在设置中配置' };
    if (!filePath) return { objectUrl: '', error: 'filePath 为空' };

    let client: S3Client;
    try {
      client = this.getClient();
    } catch (err) {
      return { objectUrl: '', error: err instanceof Error ? err.message : String(err) };
    }

    const fs = await import('node:fs');
    if (!fs.existsSync(filePath)) {
      return { objectUrl: '', error: `文件不存在: ${filePath}` };
    }
    const body = fs.createReadStream(filePath);
    body.on('error', () => {}); // 防止未监听 error 抛出
    const ext = path.extname(filePath);
    const key = `agent-outputs/${randomUUID()}${ext}`;

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
        }),
      );

      let objectUrl: string;
      if (config.publicUrlBase) {
        objectUrl = joinPublicUrl(config.publicUrlBase, key);
      } else {
        objectUrl = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { expiresIn: 7 * 24 * 3600 },
        );
      }

      return { objectUrl };
    } catch (err) {
      return { objectUrl: '', error: err instanceof Error ? err.message : String(err) };
    } finally {
      body.destroy();
    }
  }

  async testConnection(config: StorageConfig): Promise<{ success: boolean; message: string }> {
    try {
      const client = new S3Client({
        endpoint: config.endpoint || undefined,
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.forcePathStyle,
      });
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return { success: true, message: '连接成功，bucket 可访问' };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function joinPublicUrl(base: string, key: string): string {
  const b = base.replace(/\/+$/, '');
  const k = key.replace(/^\/+/, '');
  return `${b}/${k}`;
}
