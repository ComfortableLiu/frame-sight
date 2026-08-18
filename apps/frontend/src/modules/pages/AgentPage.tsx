import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
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
import { selectModelConfig, selectModelConfigLoaded, setModelConfig } from '../../store/modelConfigSlice.js';
import { store, cacheSave } from '../../store/index.js';
import { selectAgentChatModelId } from '../../store/flowSlice.js';
import {
  createLlmCaller,
  createToolRegistry,
  runAgent,
  serializeResultPayload,
  parseResultPayload,
  type ToolRuntimeDeps,
  type AgentRunInput,
  type AgentStage,
  type TodoItem,
} from '../../agent/index.js';
import { resolveModelChatEndpoint } from '../../utils/modelChatEndpoint.js';
import { generateStructuredReport, generateSrtWithRetry, type ReportProgress } from '../../agent/report.js';
import { formatDuration } from '../../agent/benchmark.js';
import { runStartupBench, loadSavedBench, type StartupBenchResult } from '../../agent/startupBench.js';
import { useTheme } from '../../hooks/useTheme.js';
import { useRouter } from '../router/Router.js';
import { MessageView, stageToLabel } from './agentPageHelpers.js';
import { AnalysisProgressModal } from './AnalysisProgressModal.js';
import { ReportViewerModal } from './ReportViewerModal.js';

function newId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AgentPage(): JSX.Element {
  const dispatch = useDispatch();
  const sessions = useSelector(selectAgentSessionsSorted);
  const currentSession = useSelector(selectCurrentAgentSession);
  const agentChatModelId = useSelector(selectAgentChatModelId);
  const modelConfig = useSelector(selectModelConfig);
  const modelConfigLoaded = useSelector(selectModelConfigLoaded);

  const [videoPath, setVideoPath] = useState('');
  const [structuredReport, setStructuredReport] = useState('');
  const [srtText, setSrtText] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [reportStatus, setReportStatus] = useState<'idle' | 'generating' | 'ready'>('idle');
  const [reportEstimate, setReportEstimate] = useState<string>('');
  const [reportProgress, setReportProgress] = useState<ReportProgress | null>(null);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportViewerOpen, setReportViewerOpen] = useState(false);
  const [viewerDirPath, setViewerDirPath] = useState<string | null>(null);
  const [viewerInitialTab, setViewerInitialTab] = useState<'report' | 'srt'>('report');
  const [confirmGenerateOpen, setConfirmGenerateOpen] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ promptTokens: number; completionTokens: number } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [startupBench, setStartupBench] = useState<StartupBenchResult | null>(loadSavedBench);
  const [benchStatus, setBenchStatus] = useState<string>(startupBench ? '' : '测速中…');
  const [stage, setStage] = useState<AgentStage>({ kind: 'idle' });
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [input, setInput] = useState('');
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const { push: pushRoute } = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  const reportAbortRef = useRef<AbortController | null>(null);
  /** 上一次写入聊天列表的阶段标签（去重连续重复阶段） */
  const lastStatusLabelRef = useRef('');
  /** 各阶段实测计时（ETA 用） */
  const progressTimingRef = useRef<{ phase: string; startTs: number } | null>(null);
  /** 已自动尝试过报告生成的视频路径，失败时不重复自动触发（避免重试风暴/StrictMode 双跑） */
  const reportAutoTriedRef = useRef<string>('');
  const sessionCreatedRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentSession) {
      const vp = currentSession.videoPath ?? '';
      setVideoPath(vp);
      sessionCreatedRef.current = currentSession.id;
      // 会话恢复不触发自动重新生成，只尝试从本地缓存恢复报告
      reportAutoTriedRef.current = vp;
      if (vp) {
        (async () => {
          try {
            const size = (await window.viewPoint.statFile(vp))?.size ?? 0;
            const cached = await window.viewPoint.getReportCache({ filePath: vp, size });
            if (cached?.hit && cached.srt && cached.report) {
              setSrtText(cached.srt);
              setStructuredReport(cached.report);
              setReportStatus('ready');
            }
          } catch { /* 缓存读取失败忽略 */ }
        })();
      }
    }
  }, [currentSession?.id]);

  // 启动时加载模型配置（此前仅设置页加载，首次选视频时配置为空会报"模型配置无效"）
  useEffect(() => {
    if (modelConfigLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await window.viewPoint.getModelConfig();
        if (!cancelled && config?.platforms) dispatch(setModelConfig(config));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [modelConfigLoaded, dispatch]);

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
    // 中止上一个视频未完成的报告生成，避免旧结果覆盖新视频状态
    reportAbortRef.current?.abort();
    reportAbortRef.current = null;
    reportAutoTriedRef.current = '';
    // 先取时长再设置 videoPath：自动报告流程在 videoPath 变化后立即启动，
    // 若此时 durationSeconds 未就绪会导致视频无法切分（退化为纯文本分析）
    let duration: number | null = null;
    try {
      duration = await window.viewPoint.getMediaDuration(res.filePath);
    } catch {
      duration = null;
    }
    setDurationSeconds(duration);
    setVideoPath(res.filePath);
    setStructuredReport('');
    setSrtText('');
    setReportStatus('idle');
    setReportError(null);
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
      // 直接读 store 最新状态：异步流程中 React 闭包里的 sessions 是过期的，
      // 用旧 messages 数组 upsert 会把刚追加的消息冲掉（表现为回复丢失）
      const s = store.getState().flow.agentSessions[sessionId];
      if (!s) return;
      dispatch(upsertAgentSession({ ...s, messages: [...s.messages, message] }));
      cacheSave();
    },
    [dispatch],
  );

  const updateSession = useCallback(
    (session: AgentChatSession, patch: Partial<AgentChatSession>) => {
      dispatch(upsertAgentSession({ ...session, ...patch }));
      cacheSave();
    },
    [dispatch],
  );

  const ensureReport = useCallback(async (force = false) => {
    if (!videoPath) throw new Error('请先选择视频');
    if (!force && reportStatus === 'ready' && structuredReport) return;

    // 本地缓存：同一文件（路径+大小）直接命中，不重复调用模型；force（手动重新生成）跳过
    const fileSize = (await window.viewPoint.statFile(videoPath).catch(() => null))?.size ?? 0;
    if (!force) {
      try {
        const cached = await window.viewPoint.getReportCache({ filePath: videoPath, size: fileSize });
        if (cached?.hit && cached.srt && cached.report) {
          setSrtText(cached.srt);
          setStructuredReport(cached.report);
          setReportStatus('ready');
          setReportError(null);
          return;
        }
      } catch { /* 缓存读取失败不影响正常生成 */ }
    }

    if (!agentChatModelId) throw new Error('请先在设置中配置 Agent 模型');
    const analysisModels = modelConfig?.analysisModels;
    // 按角色解析模型：文本/视频分析模型未配置或解析失败时回退 Agent 模型
    const textEndpoint =
      (analysisModels?.text ? resolveModelChatEndpoint(analysisModels.text, modelConfig) : null) ??
      resolveModelChatEndpoint(agentChatModelId, modelConfig);
    const videoEndpoint =
      (analysisModels?.video ? resolveModelChatEndpoint(analysisModels.video, modelConfig) : null) ??
      resolveModelChatEndpoint(agentChatModelId, modelConfig);
    if (!textEndpoint || !videoEndpoint) throw new Error('模型配置无效');

    // 中止上一次仍在进行的生成，保证同一时刻只有一个报告任务
    reportAbortRef.current?.abort();
    const controller = new AbortController();
    reportAbortRef.current = controller;

    setReportStatus('generating');
    setReportProgress(null);
    setReportError(null);
    setAnalysisModalOpen(true);
    setReportEstimate('');
    setTokenUsage(null);
    progressTimingRef.current = null;

    // 包装 caller：实时累计 token 消耗
    const usage = { promptTokens: 0, completionTokens: 0 };
    const trackUsage = (caller: ReturnType<typeof createLlmCaller>): ReturnType<typeof createLlmCaller> =>
      async (messages, options) =>
        caller(messages, {
          ...options,
          onUsage: (u) => {
            usage.promptTokens += u.promptTokens;
            usage.completionTokens += u.completionTokens;
            setTokenUsage({ ...usage });
            options?.onUsage?.(u);
          },
        });
    const textCaller = trackUsage(createLlmCaller(textEndpoint));
    const videoCaller = trackUsage(createLlmCaller(videoEndpoint));

    try {
      const { srt, report } = await generateStructuredReport({
        textCaller,
        textEndpoint,
        videoCaller,
        videoPath,
        durationSeconds,
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted) return;
          setReportProgress(progress);
          // 实测驱动 ETA：按当前阶段已完成进度推算剩余时间
          const now = Date.now();
          if (progress.total > 0 && progress.current > 0) {
            const timing = progressTimingRef.current;
            if (!timing || timing.phase !== progress.phase) {
              progressTimingRef.current = { phase: progress.phase, startTs: now };
            } else {
              const elapsedSec = (now - timing.startTs) / 1000;
              const remainingSec = (elapsedSec / progress.current) * (progress.total - progress.current);
              setReportEstimate(formatDuration(Math.max(1, Math.ceil(remainingSec))));
            }
          }
        },
        uploadToObjectStorage: (fp: string) => window.viewPoint.uploadToObjectStorage(fp),
      });
      if (controller.signal.aborted) return; // 已被新任务取代，静默丢弃
      setSrtText(srt);
      setStructuredReport(report);
      setReportStatus('ready');
      setReportProgress(null);
      // 写入本地缓存，下次选择同一视频直接命中
      window.viewPoint.saveReportCache({ filePath: videoPath, size: fileSize, srt, report }).catch(() => {});
    } catch (err) {
      if (controller.signal.aborted) return; // 中止导致的失败不更新状态
      setReportStatus('idle');
      setReportProgress(null);
      setReportError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [videoPath, reportStatus, structuredReport, agentChatModelId, modelConfig, durationSeconds, startupBench]);

  const handleCloseAnalysisModal = useCallback(() => setAnalysisModalOpen(false), []);

  const handleRetryAnalysis = useCallback(() => {
    ensureReport().catch((err) => console.warn('报告重试失败:', err));
  }, [ensureReport]);

  // 手动重新生成：先清空该视频的所有缓存（报告 + SRT），再从头完整生成
  const handleRegenerate = useCallback(async () => {
    if (videoPath) {
      try {
        const size = (await window.viewPoint.statFile(videoPath))?.size ?? 0;
        await window.viewPoint.clearReportCache({ filePath: videoPath, size });
      } catch { /* 清理失败不阻断重新生成 */ }
    }
    ensureReport(true).catch((err) => console.warn('手动重新生成失败:', err));
  }, [ensureReport, videoPath]);

  // 打开产物查看弹窗（携带当前会话产物目录）
  const handleOpenReportViewer = useCallback(async () => {
    let dir: string | null = null;
    if (currentSession?.outputDir) {
      try {
        const r = await window.viewPoint.ensureAgentOutputDir({ dirName: currentSession.outputDir });
        dir = r.absPath || null;
      } catch { /* 无产物目录则不显示入口 */ }
    }
    setViewerDirPath(dir);
    setReportViewerOpen(true);
  }, [currentSession?.outputDir]);

  // 结果按钮 open 动作：查看报告 / 查看字幕 → 打开产物弹窗对应 tab
  const handleOpenTarget = useCallback((target: string) => {
    if (target === 'view-report' || target === 'view-srt') {
      setViewerInitialTab(target === 'view-srt' ? 'srt' : 'report');
      handleOpenReportViewer();
    }
  }, [handleOpenReportViewer]);

  // 顶栏状态模块点击：缺失→询问是否生成；生成中→打开进度弹窗；就绪→查看产物；失败→打开错误/重试弹窗
  const handleStatusClick = useCallback(() => {
    if (!videoPath) return;
    if (reportError || reportStatus === 'generating') {
      setAnalysisModalOpen(true);
      return;
    }
    if (reportStatus === 'ready' && structuredReport) {
      handleOpenReportViewer();
      return;
    }
    setConfirmGenerateOpen(true);
  }, [videoPath, reportError, reportStatus, structuredReport, handleOpenReportViewer]);

  // 确认生成报告
  const handleConfirmGenerate = useCallback(() => {
    setConfirmGenerateOpen(false);
    if (!agentChatModelId) { pushRoute('settings'); return; }
    ensureReport().catch((err) => console.warn('手动生成报告失败:', err));
  }, [agentChatModelId, ensureReport, pushRoute]);

  // 选择视频后自动开始报告生成（同一视频只自动尝试一次，失败走手动重试）
  useEffect(() => {
    if (!videoPath || !agentChatModelId || !modelConfigLoaded || reportStatus !== 'idle') return;
    if (reportAutoTriedRef.current === videoPath) return;
    reportAutoTriedRef.current = videoPath;
    let cancelled = false;
    (async () => {
      try {
        await ensureReport();
      } catch (err) {
        if (!cancelled) console.warn('自动报告生成失败:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [videoPath, agentChatModelId, modelConfigLoaded, reportStatus, ensureReport]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;
    if (!agentChatModelId) { pushRoute('settings'); return; }
    if (!videoPath) return;
    // 报告未生成完成前不允许发送需求
    if (reportStatus !== 'ready' || !structuredReport) return;

    const session = ensureSession();
    appendMessage(session.id, { id: newId(), role: 'user', content: text, timestamp: Date.now() });
    // 默认标题：第一条用户消息截取前 20 字（仅尚未命名时设置）
    const cur = store.getState().flow.agentSessions[session.id];
    if (cur && (!cur.title || cur.title === '新会话')) {
      dispatch(upsertAgentSession({ ...cur, title: text.slice(0, 20) }));
      cacheSave();
    }
    setInput('');
    dispatch(setAgentSessionRunning({ sessionId: session.id, isRunning: true }));
    setTodos([]);
    setStage({ kind: 'classifying_intent' });
    lastStatusLabelRef.current = '';

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await ensureReport();
      const endpoint = resolveModelChatEndpoint(agentChatModelId, modelConfig);
      if (!endpoint) throw new Error('模型配置无效');
      const caller = createLlmCaller(endpoint);
      // generateSrt 走文本分析模型（未配置或解析失败时回退 Agent 模型）
      const textRef = modelConfig?.analysisModels?.text;
      const textEndpoint =
        (textRef ? resolveModelChatEndpoint(textRef, modelConfig) : null) ?? endpoint;
      const textCaller = createLlmCaller(textEndpoint);
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
        generateSrt: async (vp: string, signal?: AbortSignal) =>
          generateSrtWithRetry(textCaller, textEndpoint, vp, signal, (fp: string) => window.viewPoint.uploadToObjectStorage(fp)),
      };
      const tools = createToolRegistry(toolDeps);
      const freshSession = store.getState().flow.agentSessions[session.id] ?? session;
      const conversationMessages = freshSession.messages
        .filter((m) => !m.cancelled && !m.isStepMessage && !m.isStatusMessage && m.role !== 'system')
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
        runId,
        callbacks: {
          onStageChange: (s) => {
            setStage(s);
            // 阶段流转同步写入聊天列表；react_executing 由步骤消息覆盖，idle 无意义
            if (s.kind === 'idle' || s.kind === 'react_executing') return;
            const label = stageToLabel(s);
            if (!label || label === lastStatusLabelRef.current) return;
            lastStatusLabelRef.current = label;
            appendMessage(session.id, {
              id: newId(),
              role: 'assistant',
              content: label,
              timestamp: Date.now(),
              isStatusMessage: true,
            });
          },
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
      // updateSession 必须基于最新会话（含刚追加的消息），否则会用过期 messages 覆盖
      const latest = store.getState().flow.agentSessions[session.id] ?? session;
      if (output.updatedTaskState) updateSession(latest, { taskState: output.updatedTaskState });
      await window.viewPoint.agentScriptToolCleanup(runId);
    } catch (err) {
      appendMessage(session.id, { id: newId(), role: 'assistant', content: `⚠️ 出错：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
    } finally {
      dispatch(setAgentSessionRunning({ sessionId: session.id, isRunning: false }));
      setStage({ kind: 'idle' });
      abortRef.current = null;
    }
  }, [input, isRunning, agentChatModelId, videoPath, reportStatus, ensureSession, appendMessage, dispatch, ensureReport, modelConfig, sessions, durationSeconds, structuredReport, srtText, updateSession]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    if (currentSession) dispatch(setAgentSessionRunning({ sessionId: currentSession.id, isRunning: false }));
  }, [currentSession, dispatch]);

  // 提交会话重命名
  const handleRenameCommit = useCallback(() => {
    if (renamingSessionId) {
      const s = store.getState().flow.agentSessions[renamingSessionId];
      const title = renamingTitle.trim();
      if (s && title) {
        dispatch(upsertAgentSession({ ...s, title: title.slice(0, 50) }));
        cacheSave();
      }
    }
    setRenamingSessionId(null);
  }, [renamingSessionId, renamingTitle, dispatch]);

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

  const reportStatusClass = reportError
    ? 'error'
    : reportStatus === 'ready'
      ? 'ready'
      : reportStatus === 'generating'
        ? 'generating'
        : '';

  const reportStatusText = (() => {
    if (reportError) return '⚠ 分析失败';
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

        <button
          className={`topbar-status topbar-status-btn ${reportStatusClass}`}
          onClick={handleStatusClick}
          disabled={!videoPath}
          title={
            reportError
              ? '查看错误详情'
              : reportStatus === 'ready'
                ? '查看分析产物'
                : reportStatus === 'generating'
                  ? '查看分析进度'
                  : '点击生成内容分析报告'
          }
        >
          {reportStatusText}
        </button>

        {reportStatus === 'ready' && structuredReport && (
          <>
            <button className="btn" onClick={handleOpenReportViewer}>
              查看产物
            </button>
            <button className="btn" onClick={handleRegenerate} title="清空缓存，从头重新分析当前视频">
              重新生成
            </button>
          </>
        )}

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
              <MessageView key={msg.id} message={msg} onOpenTarget={handleOpenTarget} />
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
              placeholder={
                !agentChatModelId
                  ? '请先在设置中配置 Agent 模型'
                  : videoPath && reportStatus !== 'ready'
                    ? '内容分析报告生成中，完成后才能发送需求…'
                    : '输入需求…（如：去掉静音段并导出）'
              }
              disabled={isRunning || !agentChatModelId || (!!videoPath && reportStatus !== 'ready')}
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
                  disabled={!agentChatModelId || !videoPath || !input.trim() || reportStatus !== 'ready'}
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
                {renamingSessionId === s.id ? (
                  <input
                    className="session-rename-input"
                    autoFocus
                    value={renamingTitle}
                    onChange={(e) => setRenamingTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={handleRenameCommit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameCommit();
                      if (e.key === 'Escape') setRenamingSessionId(null);
                    }}
                  />
                ) : (
                  <span
                    className="session-title"
                    title="右击重命名"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRenamingSessionId(s.id);
                      setRenamingTitle(s.title || '');
                    }}
                  >
                    {s.title || '未命名'}
                  </span>
                )}
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

      {/* 视频内容分析过程弹窗 */}
      {analysisModalOpen && (
        <AnalysisProgressModal
          status={reportError ? 'error' : reportStatus === 'ready' ? 'ready' : 'generating'}
          progress={reportProgress}
          estimate={reportEstimate}
          error={reportError}
          tokenUsage={tokenUsage}
          onRetry={handleRetryAnalysis}
          onClose={handleCloseAnalysisModal}
        />
      )}

      {/* 分析产物查看弹窗 */}
      {reportViewerOpen && (
        <ReportViewerModal
          report={structuredReport}
          srt={srtText}
          outputDirPath={viewerDirPath}
          initialTab={viewerInitialTab}
          onClose={() => setReportViewerOpen(false)}
        />
      )}

      {/* 报告缺失时点击状态模块的确认弹窗 */}
      {confirmGenerateOpen && (
        <div className="modal-overlay" onClick={() => setConfirmGenerateOpen(false)}>
          <div className="modal-box" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>内容分析报告</h3>
              <button className="btn-icon" onClick={() => setConfirmGenerateOpen(false)} style={{ fontSize: 20 }}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--text-secondary)' }}>
                当前视频尚未生成内容分析报告，是否立即生成？
              </p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmGenerateOpen(false)}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleConfirmGenerate}>
                  生成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}


