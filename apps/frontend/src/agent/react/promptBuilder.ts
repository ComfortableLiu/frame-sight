import type {
  AgentTaskState,
  AgentTool,
  LlmMessage,
  TodoItem,
  VideoContext,
} from '../types.js';

export function buildToolTable(tools: AgentTool[]): string {
  if (!tools.length) return '（无可用工具）';
  return tools
    .map((t) => {
      const params = JSON.stringify(t.parameters);
      return `### ${t.name}\n显示名: ${t.displayName}\n类别: ${t.category}\n描述: ${t.description}\n参数(JSON Schema): ${params}`;
    })
    .join('\n\n');
}

export function buildTaskDirectiveBlock(taskState: AgentTaskState | undefined): string {
  if (!taskState) return '';
  const current = taskState.currentTask
    ? `## CURRENT_TASK（当前必须执行的指令，权威来源）\n${taskState.currentTask}`
    : '## CURRENT_TASK\n（暂无当前任务，本次为首个任务）';
  const ignore = taskState.finishedTasks.slice(-5);
  const ignoreBlock = ignore.length
    ? `## IGNORE（以下任务已完成，勿重复执行）\n${ignore
        .map((t, i) => `${i + 1}. [${t.taskId}] ${t.description} → ${t.result}`)
        .join('\n')}`
    : '## IGNORE\n（无已完成任务）';
  return `${current}\n\n${ignoreBlock}`;
}

export function buildReActSystemPrompt(
  videoContext: VideoContext,
  tools: AgentTool[],
  taskState: AgentTaskState | undefined,
): string {
  const duration = videoContext.durationSeconds
    ? `${Math.round(videoContext.durationSeconds)} 秒`
    : '未知';
  const report = videoContext.structuredReport
    ? truncate(videoContext.structuredReport, 6000)
    : '（缺失，需要时可调用 transcribe_audio 生成）';
  const srt = videoContext.srtText ? truncate(videoContext.srtText, 8000) : '（缺失）';

  return `你是 ViewPoint Agent，一个视频分析与自动剪辑助手。

## 视频上下文
- 本地路径: ${videoContext.localVideoPath}
- 时长: ${duration}
- preparedId: ${videoContext.preparedId}
- inputPath: ${videoContext.inputPath}

## 结构化拉片报告
${report}

## SRT 字幕
${srt}

## 工具表
${buildToolTable(tools)}

${buildTaskDirectiveBlock(taskState)}

## 响应格式（严格遵守）
- 首轮：先输出 \`\`\`todos 代码块（JSON 数组，每项 {id, description, toolHint?}），再输出第一个 \`\`\`tool_call 代码块（JSON: {name, arguments}）。
- 续轮：输出 \`\`\`tool_call（继续推进焦点 TODO），或输出 \`{"status":"done","todo_id":"t1"}\` 表示某 TODO 完成，或输出 \`{"todos_added":[...]}\`/\`{"todos_updated":[...]}\` 调整计划。
- 全部 TODO 完成后，输出最终 Markdown 总结，不再调用工具。
- 工具失败 ≥2 次时，换思路（调整参数或换工具），不要无限重试。
- 仅基于视频数据回答；时间戳对齐到字幕边界。`;
}

export function buildFirstTurnPrompt(userInput: string): string {
  return `用户需求: ${userInput}

请先制定 TODO 计划（\`\`\`todos），然后输出第一个 \`\`\`tool_call。`;
}

export function buildTodoSnapshotTable(todos: TodoItem[]): string {
  if (!todos.length) return '（无 TODO）';
  return todos
    .map(
      (t) =>
        `- [${t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.id}: ${t.description}${t.toolHint ? ` (hint: ${t.toolHint})` : ''}${t.lastError ? ` ⚠️${t.lastError}` : ''}`,
    )
    .join('\n');
}

export function buildSubsequentTurnPrompt(
  todos: TodoItem[],
  focus: TodoItem | null,
  failureHint?: string,
): string {
  const snapshot = buildTodoSnapshotTable(todos);
  const focusBlock = focus
    ? `## 焦点 TODO（本轮推进）\n${focus.id}: ${focus.description}${focus.lastError ? `\n上次错误: ${focus.lastError}` : ''}${focus.attempts >= 2 ? '\n注意：已失败≥2次，请换思路。' : ''}`
    : '## 焦点 TODO\n（无待办，若全部完成请输出最终总结）';
  const failure = failureHint ? `\n## 失败提示\n${failureHint}\n` : '';
  return `${failure}## TODO 快照\n${snapshot}\n\n${focusBlock}\n\n请输出下一个 \`\`\`tool_call 或完成信号或 todos 调整。`;
}

export function buildToolResultMessage(
  toolName: string,
  result: { success: boolean; output: string; error?: string },
): LlmMessage {
  const status = result.success ? '成功' : '失败';
  const body = result.success
    ? result.output
    : `错误: ${result.error ?? '未知错误'}\n原始输出: ${result.output}`;
  return {
    role: 'system',
    content: `## 工具执行结果 [${toolName}] — ${status}\n\`\`\`\n${truncate(body, 6000)}\n\`\`\``,
  };
}

/** 移除 <thinking>...</thinking> 围栏内容。 */
export function filterThinkingFromMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => ({
    ...m,
    content: m.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim(),
  }));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[截断，共 ${text.length} 字符]`;
}
