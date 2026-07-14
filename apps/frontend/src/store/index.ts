import { configureStore } from '@reduxjs/toolkit';
import flowReducer, {
  type FlowState,
  selectAgentSessionsSorted,
} from './flowSlice.js';
import modelConfigReducer from './modelConfigSlice.js';

const CACHE_KEY = 'frame-sight:flow-cache';

export interface RootState {
  flow: FlowState;
  modelConfig: ReturnType<typeof modelConfigReducer>;
}

export const store = configureStore({
  reducer: {
    flow: flowReducer,
    modelConfig: modelConfigReducer,
  },
});

// ── cacheSave 持久化：会话状态落盘到 localStorage ──

export function cacheSave(): void {
  try {
    const state = store.getState();
    const data = {
      flow: state.flow,
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // 忽略序列化/存储错误
  }
}

export function cacheLoad(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.flow) {
      store.dispatch({
        type: 'flow/restoreState',
        payload: data.flow,
      });
    }
  } catch {
    // 忽略
  }
}

export type AppDispatch = typeof store.dispatch;
export { selectAgentSessionsSorted };
