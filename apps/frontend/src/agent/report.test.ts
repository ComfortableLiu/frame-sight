import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateStructuredReport } from './report.js';
import type { LlmCaller, LlmMessage } from './types.js';

const SAMPLE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:05,000',
  '你好',
  '',
  '2',
  '00:00:05,000 --> 00:00:10,000',
  '世界',
  '',
].join('\n');

interface RecordedCall {
  messages: LlmMessage[];
}

function installViewPointMock(): void {
  (globalThis as Record<string, unknown>).window = {
    viewPoint: {
      // 未配置 ASR → 走通用转写回退链
      getVoiceConfig: vi.fn(async () => null),
      extractAudioFromVideo: vi.fn(async () => ({ success: true, outputPath: '/tmp/audio_x.mp3' })),
      readFileAsBase64: vi.fn(async () => ({ success: true, base64: 'QUJD', size: 3 })),
      getMediaDuration: vi.fn(async () => 10),
      ffmpegExecute: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 })),
      deleteFile: vi.fn(async () => ({ success: true })),
    },
  };
}

describe('generateStructuredReport 视频分析链路', () => {
  beforeEach(() => {
    installViewPointMock();
    // /audio/transcriptions 不可用（404）→ 回退多模态 chat 转写
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('SRT 完成后应切割视频、上传 S3，并把 video_url 发给视频模型', async () => {
    const textCalls: RecordedCall[] = [];
    const videoCalls: RecordedCall[] = [];
    // textCaller：第一次是多模态转写回退（返回 SRT），之后是合并报告
    let textCallCount = 0;
    const textCaller: LlmCaller = async (messages) => {
      textCallCount += 1;
      textCalls.push({ messages });
      return textCallCount === 1 ? SAMPLE_SRT : '# 合并报告';
    };
    const videoCaller: LlmCaller = async (messages) => {
      videoCalls.push({ messages });
      return '该段视频分析';
    };

    const uploaded: string[] = [];
    const { report } = await generateStructuredReport({
      textCaller,
      textEndpoint: { apiBase: 'https://api.test/v1', apiKey: 'k', modelName: 'm', supportsThinking: true },
      videoCaller,
      videoPath: '/tmp/video.mp4',
      durationSeconds: 10,
      uploadToObjectStorage: async (fp: string) => {
        uploaded.push(fp);
        return { objectUrl: 'https://s3.test/seg.mp4' };
      },
    });

    // 视频模型必须被调用，且 content 含 S3 URL 的 video_url part
    expect(videoCalls.length).toBeGreaterThan(0);
    const content = videoCalls[0].messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as unknown as Array<{ type: string; video_url?: { url: string } }>;
    const videoPart = parts.find((p) => p.type === 'video_url');
    expect(videoPart?.video_url?.url).toBe('https://s3.test/seg.mp4');
    // 视频分段应被上传 S3
    expect(uploaded.some((p) => p.includes('segment_'))).toBe(true);
    expect(report).toContain('合并报告');
  });
});
