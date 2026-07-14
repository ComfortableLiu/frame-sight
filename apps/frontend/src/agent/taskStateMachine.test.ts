import { describe, it, expect } from 'vitest';
import {
  createInitialTaskState,
  applyTaskAction,
  summarizeTaskResult,
} from './taskStateMachine.js';

describe('taskStateMachine', () => {
  it('starts empty with epoch 0', () => {
    const s = createInitialTaskState();
    expect(s.currentTask).toBe('');
    expect(s.currentTaskId).toBe('');
    expect(s.epoch).toBe(0);
    expect(s.finishedTasks).toEqual([]);
  });

  it('new_task archives old and increments epoch', () => {
    let s = createInitialTaskState();
    s = applyTaskAction(s, 'new_task', '任务A');
    expect(s.currentTask).toBe('任务A');
    expect(s.epoch).toBe(1);
    const epochA = s.epoch;
    s.currentTaskResult = '结果A';
    s = applyTaskAction(s, 'new_task', '任务B');
    expect(s.currentTask).toBe('任务B');
    expect(s.epoch).toBe(epochA + 1);
    expect(s.finishedTasks).toHaveLength(1);
    expect(s.finishedTasks[0].description).toBe('任务A');
    expect(s.finishedTasks[0].result).toBe('结果A');
  });

  it('correction updates text and clears result', () => {
    let s = createInitialTaskState();
    s = applyTaskAction(s, 'new_task', '任务A');
    s.currentTaskResult = '结果A';
    s = applyTaskAction(s, 'correction', '任务A修改');
    expect(s.currentTask).toBe('任务A修改');
    expect(s.currentTaskResult).toBeUndefined();
  });

  it('continuation makes no structural change', () => {
    const s = createInitialTaskState();
    const s2 = applyTaskAction(s, 'continuation', '继续');
    expect(s2).toBe(s);
  });

  it('summarizeTaskResult truncates to <=80 chars', () => {
    const long = '这是一段非常长的总结'.repeat(20);
    const summary = summarizeTaskResult(long, []);
    expect(summary.length).toBeLessThanOrEqual(80);
  });
});
