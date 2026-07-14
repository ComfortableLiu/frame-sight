import { describe, it, expect } from 'vitest';
import { parseToolCallFromText } from './parser.js';
import { parseAgentResponse, parseFirstTurnResponse, extractTodosHeuristically } from './responseParser.js';

describe('parseToolCallFromText', () => {
  it('parses standard tool_call fence', () => {
    const text = '```tool_call\n{"name":"get_video_info","arguments":{}}\n```';
    const call = parseToolCallFromText(text);
    expect(call).not.toBeNull();
    expect(call!.name).toBe('get_video_info');
    expect(call!.arguments).toEqual({});
  });

  it('parses fenced json fallback', () => {
    const text = '```json\n{"name":"detect_silence","arguments":{"minDurationSec":1}}\n```';
    const call = parseToolCallFromText(text);
    expect(call!.name).toBe('detect_silence');
    expect(call!.arguments).toEqual({ minDurationSec: 1 });
  });

  it('parses bare json', () => {
    const text = 'before {"name":"export_segment","arguments":{"format":"gif"}} after';
    const call = parseToolCallFromText(text);
    expect(call!.name).toBe('export_segment');
  });

  it('returns null when no tool call', () => {
    expect(parseToolCallFromText('just text')).toBeNull();
  });
});

describe('parseAgentResponse', () => {
  it('extracts done signal', () => {
    const parsed = parseAgentResponse('{"status":"done","todo_id":"t1"}');
    expect(parsed.doneSignal).toEqual({ todoId: 't1' });
    expect(parsed.toolCall).toBeNull();
  });

  it('extracts todos_added', () => {
    const text = '{"todos_added":[{"id":"t2","description":"新任务"}]}';
    const parsed = parseAgentResponse(text);
    expect(parsed.todosAdded).toHaveLength(1);
    expect(parsed.todosAdded![0].id).toBe('t2');
  });
});

describe('parseFirstTurnResponse', () => {
  it('extracts initialTodos from fence', () => {
    const text =
      '```todos\n[{"id":"t1","description":"获取信息"},{"id":"t2","description":"去静音"}]\n```\n```tool_call\n{"name":"get_video_info","arguments":{}}\n```';
    const parsed = parseFirstTurnResponse(text);
    expect(parsed.initialTodos).toHaveLength(2);
    expect(parsed.toolCall!.name).toBe('get_video_info');
  });
});

describe('extractTodosHeuristically', () => {
  it('extracts from numbered list', () => {
    const text = '1. 获取视频信息\n2. 检测静音\n3. 去除静音';
    const todos = extractTodosHeuristically(text);
    expect(todos).toHaveLength(3);
    expect(todos![1].description).toBe('检测静音');
  });
});
