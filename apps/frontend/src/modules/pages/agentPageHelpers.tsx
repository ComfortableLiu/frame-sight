import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AgentChatMessage } from '../../store/flowSlice.js';
import { parseResultPayload, type ResultButton, type MediaItem } from '../../agent/index.js';
import type { AgentStage } from '../../agent/index.js';
import { parseToolReturn } from '../../agent/result/builder.js';
import { ToolContentView } from './toolContentView.js';

interface MessageViewProps {
  message: AgentChatMessage;
  /** 处理按钮的 open 动作（如 'view-report' / 'view-srt'） */
  onOpenTarget?: (target: string) => void;
}

export function MessageView({ message, onOpenTarget }: MessageViewProps): JSX.Element {
  const [previewMedia, setPreviewMedia] = useState<MediaItem | null>(null);
  const payload = parseResultPayload(message.content);

  const handleButton = (btn: ResultButton) => {
    if (btn.action === 'preview') {
      const media = typeof btn.mediaIndex === 'number' ? payload?.mediaList?.[btn.mediaIndex] : undefined;
      if (media) setPreviewMedia(media);
      return;
    }
    if (btn.action === 'download') {
      if (btn.url) window.open(btn.url, '_blank');
      return;
    }
    // open：自定义目标
    onOpenTarget?.(btn.openTarget ?? btn.id);
  };

  if (message.isStatusMessage) {
    return <div className="msg-status">{message.content}</div>;
  }

  if (message.isStepMessage) {
    const parsed = message.toolCallResult?.output ? parseToolReturn(message.toolCallResult.output) : null;
    return (
      <div className="msg msg-step">
        <div>
          <span className={`tool-badge ${message.toolCallResult?.success ? 'success' : 'error'}`}>
            {message.toolCallResult?.success ? '✓' : '✗'}
          </span>
          <code>{message.content}</code>
        </div>
        {message.toolCallArgs && (
          <div className="msg-step-args">
            {JSON.stringify(message.toolCallArgs).slice(0, 120)}
          </div>
        )}
        {parsed && (
          <div className="msg-step-result">
            {parsed.error && <div className="tool-badge error">{parsed.error}</div>}
            {parsed.description && <div className="analysis-step-detail">{parsed.description}</div>}
            {parsed.content && <ToolContentView content={parsed.content} />}
            {parsed.wosUrl && (
              <div className="analysis-step-detail">
                <a href={parsed.wosUrl} target="_blank" rel="noreferrer">{parsed.wosUrl}</a>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (payload) {
    return (
      <div className="msg msg-assistant">
        <ReactMarkdown>{payload.text}</ReactMarkdown>
        {payload.mediaList?.map((media, i) => (
          <div key={i} className="media-card">
            <div className="media-card-title">{media.title}</div>
            {media.type === 'video' || media.type === 'gif' ? (
              <video src={media.url} controls />
            ) : media.type === 'image' ? (
              <img src={media.url} alt={media.title} />
            ) : (
              <audio src={media.url} controls />
            )}
          </div>
        ))}
        {payload.buttonList && payload.buttonList.length > 0 && (
          <div className="result-btn-list">
            {payload.buttonList.map((btn) => (
              <button key={btn.id} className="btn result-btn" onClick={() => handleButton(btn)}>
                {btn.label}
              </button>
            ))}
          </div>
        )}
        {previewMedia && (
          <div className="modal-overlay" onClick={() => setPreviewMedia(null)}>
            <div className="modal-box media-preview-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{previewMedia.title}</h3>
                <button className="btn-icon" onClick={() => setPreviewMedia(null)} style={{ fontSize: 20 }}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                {previewMedia.type === 'video' || previewMedia.type === 'gif' ? (
                  <video src={previewMedia.url} controls autoPlay style={{ width: '100%' }} />
                ) : previewMedia.type === 'image' ? (
                  <img src={previewMedia.url} alt={previewMedia.title} style={{ width: '100%' }} />
                ) : (
                  <audio src={previewMedia.url} controls autoPlay style={{ width: '100%' }} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`msg ${message.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
      <ReactMarkdown>{message.content}</ReactMarkdown>
    </div>
  );
}

export function stageToLabel(stage: AgentStage): string {
  switch (stage.kind) {
    case 'idle': return '';
    case 'classifying_intent': return '识别意图…';
    case 'qa_responding': return '问答中…';
    case 'react_planning': return '规划中…';
    case 'react_executing': return `执行: ${stage.toolDisplayName}`;
    case 'react_finalizing': return '总结中…';
    case 'building_result': return '构建结果…';
    case 'done': return '完成';
    case 'error': return `错误: ${stage.message}`;
    default: return '';
  }
}
