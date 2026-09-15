import { useDispatch } from 'react-redux';
import { useRouter } from '../router/Router.js';
import { setFlowMode } from '../../store/commentarySlice.js';
import { useTheme } from '../../hooks/useTheme.js';

const cardStyle: React.CSSProperties = {
  flex: '1 1 280px',
  maxWidth: 420,
  minHeight: 220,
  padding: '28px 24px',
  borderRadius: 'var(--radius-lg, 14px)',
  border: '1px solid var(--border, #2a2d42)',
  background: 'var(--bg-surface, #161822)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  transition: 'border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease',
};

const iconBoxStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 22,
  fontWeight: 600,
  background: 'var(--bg-raised, #1e2030)',
  border: '1px solid var(--border, #2a2d42)',
};

export function HomePage(): JSX.Element {
  const dispatch = useDispatch();
  const { push } = useRouter();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const enterAgent = () => {
    dispatch(setFlowMode('agent'));
    push('agent');
  };

  const enterCommentary = () => {
    dispatch(setFlowMode('normal'));
    push('commentary-step-1');
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-base, #0f1117)',
        color: 'var(--text-primary, #e4e6f0)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          borderBottom: '1px solid var(--border, #2a2d42)',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 16 }}>Frame Sight</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="theme-switcher">
            <button
              className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`}
              onClick={() => setThemeMode('light')}
              title="浅色模式"
            >
              ☀
            </button>
            <button
              className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`}
              onClick={() => setThemeMode('dark')}
              title="深色模式"
            >
              ☾
            </button>
            <button
              className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`}
              onClick={() => setThemeMode('system')}
              title="跟随系统"
            >
              ◐
            </button>
          </div>
          <button className="btn" onClick={() => push('settings')}>
            设置
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 24px',
          gap: 28,
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 560 }}>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 10 }}>选择工作模式</div>
          <div style={{ color: 'var(--text-secondary, #8b8fa8)', fontSize: 14, lineHeight: 1.6 }}>
            Agent 模式适合自然语言对话式分析与剪辑；影视剧解说模式按七步流程生成解说短视频。
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 20,
            justifyContent: 'center',
            width: '100%',
            maxWidth: 920,
          }}
        >
          <button
            type="button"
            style={{ ...cardStyle }}
            onClick={enterAgent}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-active, #4f6ef7)';
              e.currentTarget.style.boxShadow = '0 0 0 1px var(--accent-glow, rgba(79,110,247,0.25))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border, #2a2d42)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ ...iconBoxStyle, color: 'var(--accent, #4f6ef7)' }}>AI</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Agent 模式</div>
            <div style={{ color: 'var(--text-secondary, #8b8fa8)', fontSize: 13, lineHeight: 1.6 }}>
              用自然语言描述剪辑需求，Agent 自动完成视频问答、裁剪、合成与导出。
            </div>
            <div style={{ marginTop: 'auto', color: 'var(--accent, #4f6ef7)', fontSize: 13, fontWeight: 500 }}>
              进入对话 →
            </div>
          </button>

          <button
            type="button"
            style={{ ...cardStyle }}
            onClick={enterCommentary}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-active, #4f6ef7)';
              e.currentTarget.style.boxShadow = '0 0 0 1px var(--accent-glow, rgba(79,110,247,0.25))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border, #2a2d42)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ ...iconBoxStyle, color: 'var(--success, #34d399)' }}>解</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>影视剧解说模式</div>
            <div style={{ color: 'var(--text-secondary, #8b8fa8)', fontSize: 13, lineHeight: 1.6 }}>
              上传原片，按上传脚本 → 裁剪 → 配音 → 字幕 → 成片 → 封面 → 广告 七步生成解说短视频。
            </div>
            <div style={{ marginTop: 'auto', color: 'var(--success, #34d399)', fontSize: 13, fontWeight: 500 }}>
              开始七步流程 →
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
