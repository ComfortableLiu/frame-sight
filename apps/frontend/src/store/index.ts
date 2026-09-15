import { configureStore } from '@reduxjs/toolkit';
import flowReducer, {
  type FlowState,
  selectAgentSessionsSorted,
} from './flowSlice.js';
import modelConfigReducer from './modelConfigSlice.js';
import commentaryReducer, { type CommentaryState } from './commentarySlice.js';

const CACHE_KEY = 'frame-sight:flow-cache';
const COMMENTARY_CACHE_KEY = 'frame-sight:commentary-cache';

export interface RootState {
  flow: FlowState;
  modelConfig: ReturnType<typeof modelConfigReducer>;
  commentary: CommentaryState;
}

export const store = configureStore({
  reducer: {
    flow: flowReducer,
    modelConfig: modelConfigReducer,
    commentary: commentaryReducer,
  },
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function cacheSave(): void {
  try {
    const state = store.getState();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ flow: state.flow }));
  } catch {
    // ignore
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const state = store.getState();
      localStorage.setItem(
        COMMENTARY_CACHE_KEY,
        JSON.stringify({ commentary: state.commentary }),
      );
    } catch {
      // ignore
    }
  }, 500);
}

export function cacheLoad(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.flow) {
        store.dispatch({ type: 'flow/restoreState', payload: data.flow });
      }
    }
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(COMMENTARY_CACHE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.commentary) {
        store.dispatch({ type: 'commentary/restoreCommentaryState', payload: data.commentary });
      }
    }
  } catch {
    // ignore
  }
}

// 自动订阅保存
store.subscribe(() => {
  cacheSave();
});

export type AppDispatch = typeof store.dispatch;
export { selectAgentSessionsSorted };
