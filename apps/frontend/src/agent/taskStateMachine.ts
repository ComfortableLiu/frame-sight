import type {
  AgentTaskState,
  TaskRoute,
  TaskSummary,
  ToolCallResult,
} from './types.js';

const MAX_FINISHED_TASKS = 10;

let taskCounter = 0;
function nextTaskId(): string {
  taskCounter += 1;
  return `task_${Date.now().toString(36)}_${taskCounter}`;
}

export function createInitialTaskState(): AgentTaskState {
  return {
    currentTask: '',
    currentTaskId: '',
    currentTaskResult: undefined,
    epoch: 0,
    finishedTasks: [],
    interruptedTasks: [],
  };
}

export function archiveCurrentTask(
  state: AgentTaskState,
  outcome: { result?: string; interrupted?: boolean },
): AgentTaskState {
  if (!state.currentTaskId) return state;
  const summary: TaskSummary = {
    taskId: state.currentTaskId,
    description: state.currentTask,
    result: outcome.result ?? state.currentTaskResult ?? '',
    epoch: state.epoch,
    completedAt: Date.now(),
  };
  if (outcome.interrupted) {
    return {
      ...state,
      interruptedTasks: [...state.interruptedTasks, summary].slice(-MAX_FINISHED_TASKS),
    };
  }
  return {
    ...state,
    finishedTasks: [...state.finishedTasks, summary].slice(-MAX_FINISHED_TASKS),
  };
}

/**
 * 应用任务路由动作。
 * - new_task: 归档当前任务，创建新任务，epoch+1
 * - correction: 更新 currentTask 文本，清空 currentTaskResult
 * - continuation: 不做结构变更
 */
export function applyTaskAction(
  state: AgentTaskState,
  action: TaskRoute,
  userInput: string,
): AgentTaskState {
  if (action === 'continuation') {
    return state;
  }

  if (action === 'correction') {
    if (!state.currentTaskId) {
      // 无当前任务，correction 退化为 new_task
      return applyTaskAction(state, 'new_task', userInput);
    }
    return {
      ...state,
      currentTask: userInput,
      currentTaskResult: undefined,
    };
  }

  // new_task
  const withArchive = state.currentTaskId
    ? archiveCurrentTask(state, { result: state.currentTaskResult })
    : state;
  return {
    ...withArchive,
    currentTask: userInput,
    currentTaskId: nextTaskId(),
    currentTaskResult: undefined,
    epoch: withArchive.epoch + 1,
  };
}

/**
 * 将一轮 ReAct 结果压缩为 ≤80 字摘要。
 */
export function summarizeTaskResult(
  finalAnswer: string,
  toolResults: ToolCallResult[],
): string {
  const succeeded = toolResults.filter((r) => r.success);
  const toolNames = Array.from(new Set(succeeded.map((r) => r.toolName)));
  const base = finalAnswer.trim().replace(/\s+/g, ' ');
  let summary: string;
  if (base) {
    summary = base;
  } else {
    summary = `执行工具: ${toolNames.join(', ')}`;
  }
  if (summary.length > 80) {
    summary = summary.slice(0, 77) + '…';
  }
  return summary;
}
