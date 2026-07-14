import { useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'frame-sight:theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(m: ThemeMode) {
  const root = document.documentElement;
  if (m === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', m);
  }
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'system';
    } catch {
      return 'system';
    }
  });

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => {
    if (mode === 'system') return getSystemTheme();
    return mode;
  });

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch { /* ignore */ }
    applyTheme(m);
    setResolved(m === 'system' ? getSystemTheme() : m);
  }, []);

  // 初始化主题 + 监听系统变化
  useEffect(() => {
    applyTheme(mode);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (mode === 'system') {
        // data-theme 已移除，CSS 变量自动跟随 media query
        // 只需更新 resolved 状态
        setResolved(getSystemTheme());
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  return { mode, setMode, resolved };
}
