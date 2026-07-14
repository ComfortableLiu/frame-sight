import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import ReactMarkdown from 'react-markdown';
import {
  selectCurrentAgentSession,
  selectAgentSessionsSorted,
  setAgentCurrentSessionId,
  setAgentSessionRunning,
  removeAgentSession,
  upsertAgentSession,
  generateOutputDir,
  type AgentChatMessage,
  type AgentChatSession,
} from '../../store/flowSlice.js';
import { selectModelConfig } from '../../store/modelConfigSlice.js';
import { cacheSave } from '../../store/index.js';
import { selectAgentChatModelId } from '../../store/flowSlice.js';
import {
  createLlmCaller,
  createAllTools,
  runAgent,
  serializeResultPayload,
  parseResultPayload,
  type ToolRuntimeDeps,
  type AgentRunInput,
  type AgentStage,
  type TodoItem,
} from '../../agent/index.js';
import { resolveModelChatEndpoint } from '../../utils/modelChatEndpoint.js';
import { generateStructuredReport, type ReportProgress } from '../../agent/report.js';
import { createMeasuredCaller, estimateReportDuration, formatDuration, type LlmThroughput } from '../../agent/benchmark.js';
import { runStartupBench, loadSavedBench, type StartupBenchResult } from '../../agent/startupBench.js';
import { useTheme } from '../../hooks/useTheme.js';
import { useRouter } from '../router/Router.js';

function newId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AgentPage(): JSX.Element {
  const dispatch = useDispatch();
  const sessions = useSelector(selectAgentSessionsSorted);
  const currentSession = useSelector(selectCurrentAgentSession);
  const agentChatModelId = useSelector(selectAgentChatModelId);
  const modelConfig = useSelector(selectModelConfig);

  const [videoPath, setVideoPath] = useState('');
  const [structuredReport, setStructuredReport] = useState('');
  const [srtText, setSrtText] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [reportStatus, setReportStatus] = useState<'idle' | 'generating' | 'ready'>('idle');
  const [reportEstimate, setReportEstimate] = useState<string>('');
  const [reportProgress, setReportProgress] = useState<ReportProgress | null>(null);
  const [startupBench, setStartupBench] = useState<StartupBenchResult | null>(loadSavedBench);
  const [benchStatus, setBenchStatus] = useState<string>(startupBench ? '' : '测速中…');
  const [stage, setStage] = useState<AgentStage>({ kind: 'idle' });
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [input, setInput] = useState('');
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { push: pushRoute } = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentSession) setVideoPath(currentSession.videoPath ?? '');
  }, [currentSession?.id]);

  // 启动测速（有缓存则跳过）
  useEffect(() => {
    if (startupBench) return;
    let cancelled = false;
    (async () => {
      try {
        const endpoint = agentChatModelId
          ? resolveModelChatEndpoint(agentChatModelId, modelConfig)
          : null;
        const caller = endpoint ? createLlmCaller(endpoint) : null;
        const { description } = await runStartupBench(
          caller ? () => caller : (() => null as unknown as import('../../agent/types.js').LlmCaller),
          endpoint,
        );
        if (!cancelled) {
          setStartupBench(loadSavedBench());
          setBenchStatus(description);
          // 3s 后隐藏提示
          setTimeout(() => { if (!cancelled) setBenchStatus(''); }, 5000);
        }
      } catch {
        if (!cancelled) setBenchStatus('');
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 自动滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages?.length]);

  const isRunning = currentSession?.isRunning ?? false;

  const handlePickVideo = useCallback(async () => {
    const res = await window.viewPoint.pickVideoFile();
    if (res.canceled || !res.filePath) return;
    setVideoPath(res.filePath);
    setDurationSeconds(await window.viewPoint.getMediaDuration(res.filePath));
    setStructuredReport('');
    setSrtText('');
    setReportStatus('idle');
  }, []);

  const ensureSession = useCallback((): AgentChatSession => {
    if (currentSession) return currentSession;
    const now = Date.now();
    const session: AgentChatSession = {
      id: `s_${now}_${Math.random().toString(36).slice(2, 6)}`,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      outputDir: generateOutputDir(),
      videoPath,
      isRunning: false,
    };
    dispatch(upsertAgentSession(session));
    dispatch(setAgentCurrentSessionId(session.id));
    return session;
  }, [currentSession, dispatch, videoPath]);

  const appendMessage = useCallback(
    (sessionId: string, message: AgentChatMessage) => {
      const s = sessions.find((x) => x.id === sessionId) ?? currentSession;
      if (!s) return;
      dispatch(upsertAgentSession({ ...s, messages: [...s.messages, message] }));
      cacheSave();
    },
    [sessions, currentSession, dispatch],
  );

  const updateSession = useCallback(
    (session: AgentChatSession, patch: Partial<AgentChatSession>) => {
      dispatch(upsertAgentSession({ ...session, ...patch }));
      cacheSave();
    },
    [dispatch],
  );

  const ensureReport = useCallback(async () => {
    if (!videoPath) throw new Error('请先选择视频');
    if (reportStatus === 'ready' && structuredReport) return;
    if (!agentChatModelId) throw new Error('请先在设置中配置 Agent 模型');
    const endpoint = resolveModelChatEndpoint(agentChatModelId, modelConfig);
    if (!endpoint) throw new Error('模型配置无效');

    setReportStatus('generating');
    setReportProgress(null);

    // 用启动测速结果给出初始预估
    if (startupBench) {
      const est = estimateReportDuration({
        llmThroughput: { tokensPerSec: startupBench.llmTokensPerSec, firstTokenMs: startupBench.llmFirstTokenMs },
        ffmpegSpeed: startupBench.ffmpegSpeed,
        durationSeconds,
      });
      setReportEstimate(formatDuration(est.totalSec));
    } else {
      setReportEstimate('');
    }

    // 实时跟踪 LLM 吞吐，每完成一次调用更新预估
    let llmThroughput: LlmThroughput | null = null;
    const rawCaller = createLlmCaller(endpoint);
    const caller = createMeasuredCaller(rawCaller, (t) => {
      llmThroughput = t;
    });

    try {
      const { srt, report } = await generateStructuredReport(
        caller, endpoint, videoPath, durationSeconds, undefined,
        (progress) => {
          setReportProgress(progress);
          // 每完成一步用最新吞吐重新估算剩余时间
          const est = estimateReportDuration({
            llmThroughput,
            ffmpegSpeed: startupBench?.ffmpegSpeed ?? null,
            durationSeconds,
          });
          setReportEstimate(formatDuration(est.totalSec));
        },
      );
      setSrtText(srt);
      setStructuredReport(report);
      setReportStatus('ready');
      setReportProgress(null);
    } catch (err) {
      setReportStatus('idle');
      setReportProgress(null);
      throw err;
    }
  }, [videoPath, reportStatus, structuredReport, agentChatModelId, modelConfig, durationSeconds, startupBench]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;
    if (!agentChatModelId) { pushRoute('settings'); return; }
    if (!videoPath) return;

    const session = ensureSession();
    appendMessage(session.id, { id: newId(), role: 'user', content: text, timestamp: Date.now() });
    setInput('');
    dispatch(setAgentSessionRunning({ sessionId: session.id, isRunning: true }));
    setTodos([]);
    setStage({ kind: 'classifying_intent' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await ensureReport();
      const endpoint = resolveModelChatEndpoint(agentChatModelId, modelConfig);
      if (!endpoint) throw new Error('模型配置无效');
      const caller = createLlmCaller(endpoint);
      const prepared = await window.viewPoint.prepareSource({ filePath: videoPath });
      const dirRes = await window.viewPoint.ensureAgentOutputDir({ dirName: session.outputDir ?? 'default' });
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      const toolDeps: ToolRuntimeDeps = {
        videoPath,
        preparedId: prepared.preparedId,
        inputPath: prepared.inputPath,
        outputBaseDir: dirRes.absPath,
        durationSeconds: prepared.durationSeconds ?? durationSeconds,
        srtText,
        runId,
        uploadToObjectStorage: (fp: string) => window.viewPoint.uploadToObjectStorage(fp),
        generateSrt: async (vp: string, signal?: AbortSignal) => {
          const { srt } = await generateStructuredReport(caller, endpoint, vp, durationSeconds, signal);
          return srt;
        },
      };
      const tools = createAllTools(toolDeps);
      const freshSession = sessions.find((x) => x.id === session.id) ?? session;
      const conversationMessages = freshSession.messages
        .filter((m) => !m.cancelled && !m.isStepMessage && m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const agentInput: AgentRunInput = {
        userInput: text,
        videoContext: {
          localVideoPath: videoPath,
          durationSeconds: prepared.durationSeconds ?? durationSeconds,
          structuredReport,
          srtText,
          preparedId: prepared.preparedId,
          inputPath: prepared.inputPath,
        },
        conversationContext: { messages: conversationMessages },
        llmCaller: caller,
        tools,
        endpoint,
        signal: controller.signal,
        config: { maxToolSteps: 12, enableFinalSummary: true, enableIntentClassification: true, enableTaskStateMachine: true },
        taskState: freshSession.taskState,
        callbacks: {
          onStageChange: setStage,
          onTodosReady: (t) => { setTodos(t); setTodoExpanded(true); },
          onTodoUpdate: setTodos,
          onReActStep: (step) => {
            appendMessage(session.id, {
              id: newId(),
              role: 'assistant',
              content: `工具: ${step.toolDisplayName} — ${step.result.success ? '✓' : '✗'}`,
              timestamp: Date.now(),
              isStepMessage: true,
              toolCallName: step.toolName,
              toolCallArgs: step.args,
              toolCallResult: { success: step.result.success, output: step.result.output, error: step.result.error, durationMs: step.result.durationMs, audit: step.result.audit },
            });
          },
        },
      };

      const output = await runAgent(agentInput);
      appendMessage(session.id, { id: newId(), role: 'assistant', content: serializeResultPayload(output.payload), timestamp: Date.now() });
      const latest = sessions.find((x) => x.id === session.id) ?? session;
      if (output.updatedTaskState) updateSession(latest, { taskState: output.updatedTaskState });
      await window.viewPoint.agentScriptToolCleanup(runId);
    } catch (err) {
      appendMessage(session.id, { id: newId(), role: 'assistant', content: `⚠️ 出错：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      dispatch(setAgentSessionRunning({ sessionId: session.id, isRunning: false }));
      setStage({ kind: 'idle' });
      abortRef.current = null;
    }
  }, [input, isRunning, agentChatModelId, videoPath, ensureSession, appendMessage, dispatch, ensureReport, modelConfig, sessions, durationSeconds, structuredReport, srtText, updateSession]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    if (currentSession) dispatch(setAgentSessionRunning({ sessionId: currentSession.id, isRunning: false }));
  }, [currentSession, dispatch]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (s?.outputDir) {
      try {
        const dirRes = await window.viewPoint.ensureAgentOutputDir({ dirName: s.outputDir });
        await window.viewPoint.deleteAgentOutputDir({ absPath: dirRes.absPath });
      } catch { /* ignore */ }
    }
    dispatch(removeAgentSession(sessionId));
    cacheSave();
  }, [sessions, dispatch]);

  const stageLabel = useMemo(() => stageToLabel(stage), [stage]);

  const reportStatusClass =
    reportStatus === 'ready' ? 'ready' : reportStatus === 'generating' ? 'generating' : '';

  const reportStatusText = (() => {
    if (reportStatus === 'ready') return '报告就绪';
    if (reportStatus === 'generating') {
      const est = reportEstimate ? `（预计 ${reportEstimate}）` : '';
      if (reportProgress && reportProgress.total > 0) {
        return `${reportProgress.phase} ${reportProgress.current}/${reportProgress.total} ${est}`;
      }
      return `${reportProgress?.phase ?? '生成中…'} ${est}`;
    }
    return '报告缺失';
  })();

  return (
    <div className="app-page">
      {/* ── 顶栏 ────────────────────────────────────── */}
      <div className="topbar">
        <div className="topbar-brand">ViewPoint</div>

        <button className="btn" onClick={handlePickVideo}>
          {videoPath ? '更换视频' : '选择视频'}
        </button>

        {videoPath && (
          <span className="topbar-video-name">{videoPath}</span>
        )}

        <span className={`topbar-status ${reportStatusClass}`}>
          {reportStatusText}
        </span>

        {benchStatus && (
          <span className="topbar-status" style={{ color: 'var(--success)' }}>
            ⚡ {benchStatus}
          </span>
        )}

        <div className="topbar-actions">
          {!agentChatModelId && (
            <span className="config-hint" style={{ padding: '4px 10px', fontSize: 12 }}>
              未配置模型，点击右侧设置
            </span>
          )}

          <div className="theme-switcher">
            <button
              className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`}
              onClick={() => setThemeMode('light')}
              title="浅色模式"
            >
              ☀
            </button>
            <button
              className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`}
              onClick={() => setThemeMode('dark')}
              title="深色模式"
            >
              ☾
            </button>
            <button
              className={`theme-btn ${themeMode === 'system' ? 'active' : ''}`}
              onClick={() => setThemeMode('system')}
              title="跟随系统"
            >
              ◐
            </button>
          </div>

          <button className="btn" onClick={() => pushRoute('settings')}>
            ⚙ 设置
          </button>
        </div>
      </div>

      {/* ── 主体 ────────────────────────────────────── */}
      <div className="main-area">
        {/* 聊天 */}
        <div className="chat-panel">
          <div className="chat-scroll">
            {(!currentSession || currentSession.messages.length === 0) && (
              <div className="chat-empty">
                <div className="chat-empty-icon">💬</div>
                <div>{videoPath ? '输入需求开始对话' : '请先选择一个视频文件'}</div>
              </div>
            )}
            {currentSession?.messages.map((msg) => (
              <MessageView key={msg.id} message={msg} />
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* TODO 面板 */}
          {todos.length > 0 && (
            <div className="todo-panel">
              <button className="todo-toggle" onClick={() => setTodoExpanded((v) => !v)}>
                <span>{todoExpanded ? '▾' : '▸'}</span>
                执行计划
                <span className="todo-count">
                  {todos.filter((t) => t.status === 'done').length}/{todos.length}
                </span>
              </button>
              {todoExpanded && (
                <ul className="todo-list">
                  {todos.map((t) => (
                    <li key={t.id} className="todo-item">
                      <span className={`todo-status ${t.status}`}>
                        {t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◉' : ''}
                      </span>
                      <span>
                        {t.description}
                        {t.lastError && <span className="todo-error"> ⚠ {t.lastError}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 输入区 */}
          <div className="input-area">
            <textarea
              className="input-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={agentChatModelId ? '输入需求…（如：去掉静音段并导出）' : '请先在设置中配置 Agent 模型'}
              disabled={isRunning || !agentChatModelId}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="input-footer">
              <span className="stage-label">
                {isRunning && <span className="spinner" />}
                {stageLabel}
              </span>
              {isRunning ? (
                <button className="btn btn-danger" onClick={handleStop}>
                  ■ 停止
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={handleSend}
                  disabled={!agentChatModelId || !videoPath || !input.trim()}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 侧栏 */}
        <div className="sidebar">
          <div className="sidebar-header">会话</div>
          <div className="session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === currentSession?.id ? 'active' : ''}`}
                onClick={() => dispatch(setAgentCurrentSessionId(s.id))}
              >
                <span className="session-title">{s.title || '未命名'}</span>
                <button
                  className="session-del"
                  onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                  title="删除会话"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="sidebar-new-btn"
            onClick={() => dispatch(setAgentCurrentSessionId(null))}
          >
            + 新会话
          </button>
        </div>
      </div>

    </div>
  );
}

function MessageView({ message }: { message: AgentChatMessage }): JSX.Element {
  const payload = parseResultPayload(message.content);

  if (message.isStepMessage) {
    return (
      <div className="msg msg-step">
        <div>
          <span className={`tool-badge ${message.toolCallResult?.success ? 'success' : 'error'}`}>
            {message.toolCallResult?.success ? '✓' : '✗'}
          </span>
          <code>{message.content}</code>
        </div>
        {message.toolCallArgs && (
          <div className="msg-step-args">
            {JSON.stringify(message.toolCallArgs).slice(0, 120)}
          </div>
        )}
      </div>
    );
  }

  if (payload) {
    return (
      <div className="msg msg-assistant">
        <ReactMarkdown>{payload.text}</ReactMarkdown>
        {payload.mediaList?.map((media, i) => (
          <div key={i} className="media-card">
            <div className="media-card-title">{media.title}</div>
            {media.type === 'video' || media.type === 'gif' ? (
              <video src={media.url} controls />
            ) : media.type === 'image' ? (
              <img src={media.url} alt={media.title} />
            ) : (
              <audio src={media.url} controls />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`msg ${message.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
      <ReactMarkdown>{message.content}</ReactMarkdown>
    </div>
  );
}

function stageToLabel(stage: AgentStage): string {
  switch (stage.kind) {
    case 'idle': return '';
    case 'classifying_intent': return '识别意图…';
    case 'qa_responding': return '问答中…';
    case 'react_planning': return '规划中…';
    case 'react_executing': return `执行: ${stage.toolDisplayName}`;
    case 'react_finalizing': return '总结中…';
    case 'building_result': return '构建结果…';
    case 'done': return '完成';
    case 'error': return `错误: ${stage.message}`;
    default: return '';
  }
}
