import { ensureViewPoint } from './ipc.js';

// ── window.viewPoint 安全代理（preload 未就绪时不崩溃） ──
ensureViewPoint();

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store, cacheLoad } from './store/index.js';
import { RouterProvider, useRouter } from './modules/router/Router.js';
import { AgentPage } from './modules/pages/AgentPage.js';
import { SettingsPage } from './modules/pages/SettingsPage.js';
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
    <RouterProvider>
      <AppRouter />
    </RouterProvider>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>,
  );
}
