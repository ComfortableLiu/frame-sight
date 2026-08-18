import { useEffect } from 'react';
import type { ReportProgress } from '../../agent/report.js';

/**
 * 内容分析子流程，步骤名与 report.ts 中 ReportProgress.phase 的中文阶段名一一对应。
 * 分两组展示：提取音频（分离音频 → 音频拆分 → 语音识别 → 字幕合成）、
 * 分段分析（视频拆分 → 视频分析 → 合并报告）。
 */
const PHASE_GROUPS = [
  { title: '提取音频', steps: ['分离音频', '音频拆分', '语音识别', '字幕合成'] },
  { title: '分段分析', steps: ['视频拆分', '视频分析', '合并报告'] },
] as const;

const ALL_PHASES: readonly string[] = PHASE_GROUPS.flatMap((group) => group.steps);

export type AnalysisModalStatus = 'generating' | 'ready' | 'error';

interface AnalysisProgressModalProps {
  status: AnalysisModalStatus;
  progress: ReportProgress | null;
  estimate: string;
  error: string | null;
  /** 实时 token 消耗（输入/输出） */
  tokenUsage?: { promptTokens: number; completionTokens: number } | null;
  onRetry: () => void;
  onClose: () => void;
}

type StepState = 'pending' | 'active' | 'done' | 'error';

/** 选择视频后展示内容分析子流程（提取音频 → 分段分析）过程的弹窗。分析期间不可关闭。 */
export function AnalysisProgressModal({
  status,
  progress,
  estimate,
  error,
  tokenUsage,
  onRetry,
  onClose,
}: AnalysisProgressModalProps): JSX.Element {
  const phaseIndex = progress ? ALL_PHASES.indexOf(progress.phase) : -1;
  const activeIndex = status === 'ready' ? ALL_PHASES.length : phaseIndex < 0 ? 0 : phaseIndex;
  const ratio =
    progress && progress.total > 0 ? Math.min(1, progress.current / progress.total) : null;
  // ReportProgress.detail 由 report.ts 提供（存在时显示在步骤名称旁）
  const detail = progress
    ? ((progress as ReportProgress & { detail?: string }).detail ?? null)
    : null;

  // 分析完成后短暂展示成功态再自动关闭
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setTimeout(onClose, 1200);
    return () => clearTimeout(timer);
  }, [status, onClose]);

  const stepState = (index: number): StepState => {
    if (status === 'ready' || index < activeIndex) return 'done';
    if (index === activeIndex) return status === 'error' ? 'error' : 'active';
    return 'pending';
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box analysis-modal">
        <div className="modal-header">
          <h3>视频内容分析</h3>
        </div>

        <div className="modal-body">
          {PHASE_GROUPS.map((group) => (
            <div key={group.title} className="analysis-step-group">
              <div className="analysis-step-group-title">{group.title}</div>
              <ul className="analysis-steps">
                {group.steps.map((step) => {
                  const state = stepState(ALL_PHASES.indexOf(step));
                  const showProgress = state === 'active' && progress && progress.total > 0;
                  return (
                    <li key={step} className={`analysis-step ${state}`}>
                      <span className="analysis-step-icon">
                        {state === 'done' ? (
                          '✓'
                        ) : state === 'active' ? (
                          <span className="spinner" />
                        ) : state === 'error' ? (
                          '✗'
                        ) : (
                          '○'
                        )}
                      </span>
                      <div className="analysis-step-main">
                        <span className="analysis-step-label">
                          {step}
                          {showProgress && (
                            <span className="analysis-step-count">
                              {progress.current}/{progress.total}
                            </span>
                          )}
                          {state === 'active' && detail && (
                            <span className="analysis-step-detail">{detail}</span>
                          )}
                        </span>
                        {showProgress && ratio !== null && (
                          <div className="analysis-step-progress">
                            <div
                              className="analysis-step-progress-bar"
                              style={{ width: `${Math.round(ratio * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {tokenUsage && tokenUsage.promptTokens + tokenUsage.completionTokens > 0 && (
            <div className="analysis-estimate">
              已消耗 tokens：输入 {tokenUsage.promptTokens.toLocaleString()} / 输出{' '}
              {tokenUsage.completionTokens.toLocaleString()}（共{' '}
              {(tokenUsage.promptTokens + tokenUsage.completionTokens).toLocaleString()}）
            </div>
          )}

          {status === 'generating' && estimate && (
            <div className="analysis-estimate">预计剩余 {estimate}</div>
          )}

          {status === 'ready' && <div className="analysis-done">✓ 分析完成，报告已就绪</div>}

          {status === 'error' && (
            <>
              <div className="analysis-error-banner">
                <div className="analysis-error-icon">⚠</div>
                <div className="analysis-error-title">视频内容分析失败</div>
                <div className="analysis-error-detail">{error ?? '未知错误'}</div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={onRetry}>
                  重试
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
