import { ensureViewPoint } from './ipc.js';

// ── window.viewPoint 安全代理（preload 未就绪时不崩溃） ──
ensureViewPoint();

import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { store, cacheLoad } from './store/index.js';
import { RouterProvider, useRouter } from './modules/router/Router.js';
import { AgentPage } from './modules/pages/AgentPage.js';
import { SettingsPage } from './modules/pages/SettingsPage.js';
import { HomePage } from './modules/pages/HomePage.js';
import { CommentaryLayout } from './modules/commentary/CommentaryLayout.js';
import { ErrorBoundary } from './modules/ErrorBoundary.js';
import { useTheme } from './hooks/useTheme.js';
import './styles.css';

// ── 主题初始化（React 挂载前，避免闪烁） ──
const THEME_KEY = 'frame-sight:theme';
const saved = localStorage.getItem(THEME_KEY) || 'system';
if (saved !== 'system') {
  document.documentElement.setAttribute('data-theme', saved);
}

cacheLoad();

function AppRouter(): JSX.Element {
  const { route } = useRouter();
  if (route.name.startsWith('commentary-step-')) {
    return <CommentaryLayout />;
  }
  switch (route.name) {
    case 'settings':
      return <SettingsPage />;
    case 'agent':
      return <AgentPage />;
    case 'home':
    default:
      return <HomePage />;
  }
}

/** antd 主题跟随全局 light/dark/system，并与 CSS 变量色板对齐。 */
function ThemedApp(): JSX.Element {
  const { resolved } = useTheme();
  const isDark = resolved === 'dark';

  const themeConfig = useMemo(
    () => ({
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: isDark ? '#4f6ef7' : '#3b5bdb',
        colorInfo: isDark ? '#4f6ef7' : '#3b5bdb',
        colorSuccess: isDark ? '#34d399' : '#10b981',
        colorWarning: isDark ? '#fbbf24' : '#d97706',
        colorError: isDark ? '#f87171' : '#dc2626',
        borderRadius: 8,
        colorBgBase: isDark ? '#0f1117' : '#f5f6fa',
        colorBgContainer: isDark ? '#161822' : '#ffffff',
        colorBgElevated: isDark ? '#1e2030' : '#ffffff',
        colorBgLayout: isDark ? '#0f1117' : '#f5f6fa',
        colorBorder: isDark ? '#2a2d42' : '#d8dae5',
        colorBorderSecondary: isDark ? '#2a2d42' : '#e8e9f0',
        colorText: isDark ? '#e4e6f0' : '#1a1c2b',
        colorTextSecondary: isDark ? '#8b8fa8' : '#5c6078',
        colorTextTertiary: isDark ? '#5c6078' : '#8b8fa8',
      },
    }),
    [isDark],
  );

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <RouterProvider>
        <AppRouter />
      </RouterProvider>
    </ConfigProvider>
  );
}

function App(): JSX.Element {
  return <ThemedApp />;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <ErrorBoundary>
        <Provider store={store}>
          <App />
        </Provider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
