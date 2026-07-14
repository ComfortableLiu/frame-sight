import type {
  ConversationContext,
  LlmCaller,
  LlmMessage,
  VideoContext,
} from '../types.js';

/**
 * QA 响应：基于视频时长 + 结构化报告 + SRT 字幕回答用户提问。
 * 仅基于数据、引用具体时间戳、不确定时明确说明、Markdown 排版。
 */
export async function respondToQuestion(
  caller: LlmCaller,
  userInput: string,
  videoContext: VideoContext,
  conversation: ConversationContext,
  signal?: AbortSignal,
  maxTokens = 8000,
): Promise<string> {
  const duration = videoContext.durationSeconds
    ? `${Math.round(videoContext.durationSeconds)} 秒`
    : '未知';
  const report = videoContext.structuredReport ?? '（无结构化报告）';
  const srt = videoContext.srtText ?? '（无 SRT 字幕）';

  const sys: LlmMessage = {
    role: 'system',
    content: `你是视频分析助手。仅基于下方数据回答，不编造。
- 时长: ${duration}
## 结构化拉片报告
${truncate(report, 12000)}
## SRT 字幕
${truncate(srt, 8000)}

要求：
1. 仅基于上述数据回答，引用具体时间戳（如 00:01:23）。
2. 不确定时明确说明"报告中未提及"。
3. 使用 Markdown 排版，条理清晰。`,
  };

  const history = conversation.messages
    .slice(-10)
    .map((m): LlmMessage => ({ role: m.role, content: m.content }));

  const answer = await caller([sys, ...history, { role: 'user', content: userInput }], {
    signal,
    maxTokens,
  });
  return answer;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[截断，共 ${text.length} 字符]`;
}
