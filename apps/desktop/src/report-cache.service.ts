import Store from 'electron-store';
import { createHash } from 'node:crypto';

export interface ReportCacheEntry {
  srt: string;
  report: string;
  createdAt: number;
}

export interface ReportCacheHit extends ReportCacheEntry {
  hit: true;
}

/**
 * 视频内容分析结果（SRT + 结构化报告）的本地缓存。
 * key = sha1(filePath|fileSize)，同一文件再次选择时直接命中，避免重复调用模型。
 */
export class ReportCacheService {
  private store: Store<Record<string, ReportCacheEntry>>;

  constructor() {
    this.store = new Store<Record<string, ReportCacheEntry>>({
      name: 'report-cache',
      defaults: {},
    });
  }

  private key(filePath: string, size: number): string {
    return createHash('sha1').update(`${filePath}|${size}`).digest('hex');
  }

  get(filePath: string, size: number): ReportCacheHit | { hit: false } {
    const entry = this.store.store[this.key(filePath, size)];
    return entry ? { hit: true, ...entry } : { hit: false };
  }

  save(filePath: string, size: number, srt: string, report: string): void {
    this.store.store = {
      ...this.store.store,
      [this.key(filePath, size)]: { srt, report, createdAt: Date.now() },
    };
  }

  /** SRT 独立缓存：重新生成报告时可直接复用转写结果，不必重新识别。 */
  getSrt(filePath: string, size: number): { hit: true; srt: string } | { hit: false } {
    const entry = this.store.store[`${this.key(filePath, size)}|srt`];
    return entry ? { hit: true, srt: entry.srt } : { hit: false };
  }

  saveSrt(filePath: string, size: number, srt: string): void {
    this.store.store = {
      ...this.store.store,
      [`${this.key(filePath, size)}|srt`]: { srt, report: '', createdAt: Date.now() },
    };
  }

  /** 删除该文件的所有缓存（报告 + SRT），用于手动重新生成。 */
  remove(filePath: string, size: number): void {
    const next = { ...this.store.store };
    delete next[this.key(filePath, size)];
    delete next[`${this.key(filePath, size)}|srt`];
    this.store.store = next;
  }
}
