import type { AgentTool, ToolRuntimeDeps } from '../types.js';
import * as path from '../pathShim.js';

/**
 * 语音合成工具：消费设置中的语音合成(TTS)配置生成语音音频，
 * 写入产物目录并上传到对象存储，返回可访问 URL。
 */
export function createSpeechTools(deps: ToolRuntimeDeps): AgentTool[] {
  const synthesizeSpeech: AgentTool = {
    name: 'synthesize_speech',
    displayName: '语音合成',
    category: 'editing',
    description:
      '使用设置中已启用的语音合成(TTS)服务，将文本合成为语音音频，上传到对象存储并返回可访问 URL。' +
      '参数: text(必填，待合成的文本), voice(可选，覆盖设置中的音色)。' +
      '语音风格可在设置 → 语音设置中配置"风格提示"。若未启用或未配置语音合成，将返回错误。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        voice: { type: 'string' },
      },
      required: ['text'],
    },
    handler: async (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) {
        return JSON.stringify({ ok: false, error: 'text 不能为空' });
      }

      let snap: {
        synthesis?: { enabled: boolean; apiBase: string; apiKey: string; model: string; voice: string; style?: string; format: string };
      };
      try {
        snap = await window.viewPoint.getVoiceConfig();
      } catch {
        return JSON.stringify({ ok: false, error: '读取语音合成设置失败' });
      }
      const s = snap?.synthesis;
      if (!s?.enabled) {
        return JSON.stringify({ ok: false, error: '未启用语音合成，请在设置 → 语音设置中启用并配置' });
      }
      if (!s.apiBase || !s.apiKey || !s.model) {
        return JSON.stringify({ ok: false, error: '语音合成未完整配置（API Base/Key/模型）' });
      }

      const voice = args.voice ? String(args.voice) : s.voice || undefined;
      const format = ['wav', 'mp3', 'pcm'].includes(s.format) ? s.format : 'wav';

      // chat/completions 风格（参考小米 MiMo）：
      // user 消息为可选的风格提示，assistant 消息为待合成文本，
      // audio 指定输出格式与音色。
      const messages: Array<{ role: string; content: string }> = [];
      if (s.style?.trim()) messages.push({ role: 'user', content: s.style.trim() });
      messages.push({ role: 'assistant', content: text });

      const url = joinUrl(s.apiBase, '/chat/completions');
      const body: Record<string, unknown> = {
        model: s.model,
        messages,
        audio: { format, ...(voice ? { voice } : {}) },
      };

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'api-key': s.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: `语音合成请求失败: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return JSON.stringify({ ok: false, error: `语音合成失败 ${res.status}: ${errText.slice(0, 200)}` });
      }

      const base64 = await extractAudioBase64(res);
      if (!base64) {
        return JSON.stringify({ ok: false, error: '语音合成为空结果' });
      }
      const ext = format === 'pcm' ? 'pcm' : format;
      const outputPath = path.join(deps.outputBaseDir, `speech_${Date.now()}.${ext}`);

      const writeRes = await window.viewPoint.writeBase64File({ filePath: outputPath, base64 });
      if (!writeRes.success) {
        return JSON.stringify({ ok: false, error: writeRes.error ?? '写入音频文件失败' });
      }

      const { objectUrl, uploadError } = await uploadResult(outputPath, deps);
      const result: Record<string, unknown> = {
        ok: true,
        message: '语音合成完成',
        outputPath,
        format,
        sizeBytes: Math.floor((base64.length * 3) / 4),
        text,
      };
      if (objectUrl) result.wosUrl = objectUrl;
      if (uploadError) result.uploadError = uploadError;
      return JSON.stringify(result);
    },
  };

  return [synthesizeSpeech];
}

async function uploadResult(
  filePath: string,
  deps: ToolRuntimeDeps,
): Promise<{ objectUrl?: string; uploadError?: string }> {
  try {
    const { objectUrl } = await deps.uploadToObjectStorage(filePath);
    return { objectUrl };
  } catch (err) {
    return { uploadError: err instanceof Error ? err.message : String(err) };
  }
}

function joinUrl(base: string, suffix: string): string {
  if (base.endsWith('/')) return base.slice(0, -1) + suffix;
  return base + suffix;
}

/** 从 chat/completions 响应中提取合成音频 base64（兼容 audio.data / data URL / 直链）。 */
async function extractAudioBase64(res: Response): Promise<string | null> {
  const json = (await res.json()) as {
    choices?: Array<{ message?: { audio?: { data?: string }; content?: unknown } }>;
  };
  const msg = json?.choices?.[0]?.message;
  if (msg?.audio?.data) return msg.audio.data;

  const content = msg?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p as { text?: string })?.text ?? '').join('')
        : '';
  const dataUrl = text.match(/data:audio\/[^;]+;base64,([A-Za-z0-9+/=\s]+)/);
  if (dataUrl) return dataUrl[1].replace(/\s/g, '');

  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const audioRes = await fetch(urlMatch[0]).catch(() => null);
    if (audioRes?.ok) {
      const buf = await audioRes.arrayBuffer();
      if (buf.byteLength) return arrayBufferToBase64(buf);
    }
  }
  return null;
}

/** ArrayBuffer → base64（分块避免调用栈溢出）。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}
