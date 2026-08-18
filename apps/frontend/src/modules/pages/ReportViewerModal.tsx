import { useState } from 'react';

interface ReportViewerModalProps {
  report: string;
  srt: string;
  /** 产物目录绝对路径（无会话产物时为 null） */
  outputDirPath: string | null;
  /** 初始展示的 tab，默认 report */
  initialTab?: 'report' | 'srt';
  onClose: () => void;
}

/** 查看视频内容分析产物（结构化报告 / SRT 字幕）的弹窗。 */
export function ReportViewerModal({ report, srt, outputDirPath, initialTab = 'report', onClose }: ReportViewerModalProps): JSX.Element {
  const [tab, setTab] = useState<'report' | 'srt'>(initialTab);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box report-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>分析产物</h3>
          <button className="btn-icon" onClick={onClose} style={{ fontSize: 20 }}>
            ×
          </button>
        </div>

        <div className="modal-tabs">
          <button className={`modal-tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>
            结构化报告
          </button>
          <button className={`modal-tab ${tab === 'srt' ? 'active' : ''}`} onClick={() => setTab('srt')}>
            SRT 字幕
          </button>
        </div>

        <div className="modal-body">
          <pre className="report-viewer-content">{tab === 'report' ? report : srt}</pre>

          {outputDirPath && (
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => window.viewPoint.openInFinder({ dirPath: outputDirPath })}
              >
                打开产物目录
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
