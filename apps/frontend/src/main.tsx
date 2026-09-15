import { ensureViewPoint } from './ipc.js';

// ── window.viewPoint 安全代理（preload 未就绪时不崩溃） ──
ensureViewPoint();

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { store, cacheLoad } from './store/index.js';
import { RouterProvider, useRouter } from './modules/router/Router.js';
import { AgentPage } from './modules/pages/AgentPage.js';
import { SettingsPage } from './modules/pages/SettingsPage.js';
import { CommentaryLayout } from './modules/commentary/CommentaryLayout.js';
import { ErrorBoundary } from './modules/ErrorBoundary.js';
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
    default:
      return <AgentPage />;
  }
}

function App(): JSX.Element {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: '#4f6ef7',
          borderRadius: 8,
          colorBgContainer: '#161822',
          colorBgElevated: '#1e2030',
        },
      }}
    >
      <RouterProvider>
        <AppRouter />
      </RouterProvider>
    </ConfigProvider>
  );
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
