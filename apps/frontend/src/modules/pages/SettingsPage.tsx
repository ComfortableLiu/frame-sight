import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectAgentChatModelId, setAgentChatModel } from '../../store/flowSlice.js';
import {
  selectModelConfig,
  setModelConfig,
  upsertPlatform,
  removePlatform,
  setPlatformModels,
} from '../../store/modelConfigSlice.js';
import type { ModelCapabilities, ModelConfig, ModelPlatform, StorageConfig, VoiceConfigSnapshot, VoiceSynthesisConfig, VoiceRecognitionConfig } from '../../types/modelConfig.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_VOICE_SYNTHESIS, DEFAULT_VOICE_RECOGNITION } from '../../types/modelConfig.js';
import { PLATFORM_TEMPLATES } from '../../utils/llmModels.js';
import { useRouter } from '../router/Router.js';
import { cacheSave } from '../../store/index.js';

export function SettingsPage(): JSX.Element {
  const dispatch = useDispatch();
  const { back } = useRouter();
  const modelConfig = useSelector(selectModelConfig);
  const agentChatModelId = useSelector(selectAgentChatModelId);
  const [tab, setTab] = useState<'model' | 'analysis' | 'storage' | 'voice'>('model');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await window.viewPoint.getModelConfig();
        if (!cancelled && config?.platforms) dispatch(setModelConfig(config));
      } catch { /* ignore */ }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [dispatch]);

  /** 持久化整个 modelConfig 到桌面端（保留 analysisModels 等顶层字段）。 */
  const persistConfig = (next: ModelConfig) => {
    window.viewPoint.saveModelConfig(next);
  };
  /** 更新（或新增）平台并持久化。 */
  const updatePlatform = (updated: ModelPlatform) => {
    dispatch(upsertPlatform(updated));
    const platforms = modelConfig?.platforms ?? [];
    const next = platforms.some((p) => p.id === updated.id)
      ? platforms.map((p) => (p.id === updated.id ? updated : p))
      : [...platforms, updated];
    persistConfig({ ...(modelConfig ?? { platforms: [] }), platforms: next });
  };
  /** 更新分析模型设置并持久化。 */
  const updateAnalysisModels = (patch: Partial<NonNullable<ModelConfig['analysisModels']>>) => {
    const next: ModelConfig = {
      ...(modelConfig ?? { platforms: [] }),
      analysisModels: { ...(modelConfig?.analysisModels ?? {}), ...patch },
    };
    dispatch(setModelConfig(next));
    persistConfig(next);
  };

  return (
    <div className="app-page">
      {/* 顶栏 */}
      <div className="topbar">
        <button className="btn" onClick={back}>
          ← 返回
        </button>
        <div className="topbar-brand">设置</div>
      </div>

      {/* 左目录 + 右内容 */}
      <div className="settings-layout">
        <nav className="settings-nav">
          <button
            className={`settings-nav-item ${tab === 'model' ? 'active' : ''}`}
            onClick={() => setTab('model')}
          >
            <span className="nav-icon">🤖</span>
            模型配置
          </button>
          <button
            className={`settings-nav-item ${tab === 'analysis' ? 'active' : ''}`}
            onClick={() => setTab('analysis')}
          >
            <span className="nav-icon">🧠</span>
            分析模型
          </button>
          <button
            className={`settings-nav-item ${tab === 'storage' ? 'active' : ''}`}
            onClick={() => setTab('storage')}
          >
            <span className="nav-icon">☁️</span>
            对象存储
          </button>
          <button
            className={`settings-nav-item ${tab === 'voice' ? 'active' : ''}`}
            onClick={() => setTab('voice')}
          >
            <span className="nav-icon">🎙️</span>
            语音设置
          </button>
        </nav>

        <div className="settings-body">
          {!ready ? (
            <div className="settings-loading">加载中…</div>
          ) : tab === 'model' ? (
            <ModelTab
              platforms={modelConfig?.platforms ?? []}
              agentChatModelId={agentChatModelId}
              onAdd={(p) => updatePlatform(p)}
              onRemove={(id) => {
                dispatch(removePlatform(id));
                persistConfig({
                  ...(modelConfig ?? { platforms: [] }),
                  platforms: (modelConfig?.platforms ?? []).filter((p) => p.id !== id),
                });
              }}
              onSync={async (platform) => {
                if (!platform.apiBase) {
                  alert('请先填写 API Base URL');
                  return;
                }
                try {
                  const url = platform.apiBase.replace(/\/+$/, '') + '/models';
                  const res = await fetch(url, {
                    headers: { Authorization: `Bearer ${platform.apiKey}` },
                  });
                  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                  const data = await res.json();
                  const models = Array.isArray(data?.data)
                    ? data.data.map((m: { id: string }) => m.id).filter(Boolean).sort()
                    : [];
                  if (!models.length) {
                    alert('API 返回了空模型列表');
                    return;
                  }
                  dispatch(setPlatformModels({ platformId: platform.id, models }));
                  // 同步到桌面端持久化
                  persistConfig({
                    ...(modelConfig ?? { platforms: [] }),
                    platforms: (modelConfig?.platforms ?? []).map((p) =>
                      p.id === platform.id ? { ...p, models } : p
                    ),
                  });
                } catch (err) {
                  alert(`同步失败: ${err instanceof Error ? err.message : String(err)}`);
                }
              }}
              onSelectModel={(ref) => { dispatch(setAgentChatModel(ref)); cacheSave(); }}
              onUpdatePlatform={updatePlatform}
            />
          ) : tab === 'analysis' ? (
            <AnalysisTab
              config={modelConfig ?? { platforms: [] }}
              onChange={updateAnalysisModels}
            />
          ) : tab === 'storage' ? (
            <StorageTab />
          ) : (
            <VoiceTab />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── 模型配置（两级：一级平台列表，二级模型详情） ────────── */

function ModelTab({
  platforms,
  agentChatModelId,
  onAdd,
  onRemove,
  onSync,
  onSelectModel,
  onUpdatePlatform,
}: {
  platforms: ModelPlatform[];
  agentChatModelId: string;
  onAdd: (p: ModelPlatform) => void;
  onRemove: (id: string) => void;
  onSync: (p: ModelPlatform) => Promise<void>;
  onSelectModel: (ref: string) => void;
  onUpdatePlatform: (p: ModelPlatform) => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [apiKey, setApiKey] = useState('');

  // 默认选中第一个
  const activeId = selectedId ?? platforms[0]?.id ?? null;
  const activePlatform = platforms.find((p) => p.id === activeId) ?? null;

  const closeAdd = () => { setShowAdd(false); setName(''); setApiBase(''); setApiKey(''); };
  const add = () => {
    if (!name) return;
    const p: ModelPlatform = { id: crypto.randomUUID(), name, apiBase, apiKey, models: [], selectedModels: [], contextWindows: {} };
    onAdd(p);
    setSelectedId(p.id);
    closeAdd();
  };

  /** 勾选/取消勾选某个模型（持久化 selectedModels）。 */
  const toggleModel = (platform: ModelPlatform, modelName: string, checked: boolean) => {
    const prev = platform.selectedModels ?? [];
    const selectedModels = checked
      ? [...prev, modelName]
      : prev.filter((m) => m !== modelName);
    onUpdatePlatform({ ...platform, selectedModels });
  };

  /** 更新单模型设置（上下文大小 / 能力），写入 modelSettings。 */
  const patchModelSettings = (
    platform: ModelPlatform,
    modelName: string,
    patch: { contextWindow?: number; capabilities?: ModelCapabilities },
  ) => {
    const prev = platform.modelSettings?.[modelName] ?? {};
    onUpdatePlatform({
      ...platform,
      modelSettings: {
        ...(platform.modelSettings ?? {}),
        [modelName]: { ...prev, ...patch },
      },
    });
  };

  return (
    <div className="model-two-col">
      {/* ── 添加平台弹窗 ── */}
      {showAdd && (
        <div className="modal-overlay" onClick={closeAdd}>
          <div className="modal-box" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>添加模型平台</h3>
              <button className="btn-icon" onClick={closeAdd} style={{ fontSize: 20 }}>×</button>
            </div>
            <div className="modal-body">
              <label className="field-label">模板</label>
              <select
                className="form-field"
                defaultValue=""
                onChange={(e) => {
                  const tpl = PLATFORM_TEMPLATES.find((t) => t.name === e.target.value);
                  if (tpl) { setName(tpl.name); setApiBase(tpl.apiBase); }
                }}
              >
                <option value="">选择模板快速填充…</option>
                {PLATFORM_TEMPLATES.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>

              <label className="field-label">平台别名 <span className="field-required">*</span></label>
              <input className="form-field" placeholder="如 bailian、volcano" value={name} onChange={(e) => setName(e.target.value)} />

              <label className="field-label">API Base URL</label>
              <input className="form-field" placeholder="https://api.example.com/v1" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />

              <label className="field-label">API Key</label>
              <input className="form-field" placeholder="sk-..." type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />

              <div className="modal-actions">
                <button className="btn" onClick={closeAdd}>取消</button>
                <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>添加</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 一级：平台列表 ── */}
      <div className="model-platform-list">
        <div className="model-platform-list-header">
          <span>平台</span>
          <button className="btn-icon" onClick={() => setShowAdd(true)} title="添加平台">＋</button>
        </div>

        {platforms.length === 0 && !showAdd && (
          <div className="muted-text" style={{ padding: '12px 10px' }}>暂无平台，点 ＋ 添加</div>
        )}

        {platforms.map((p) => {
          const isSelected = p.id === activeId;
          const hasSelectedModel = agentChatModelId.startsWith(`${p.name}::`);
          return (
            <button
              key={p.id}
              className={`model-platform-item ${isSelected ? 'active' : ''}`}
              onClick={() => setSelectedId(p.id)}
            >
              <span className="model-platform-icon">
                {hasSelectedModel ? '✅' : '⬜'}
              </span>
              <span className="model-platform-name">{p.name}</span>
              <span className="model-platform-count">{p.models.length}</span>
            </button>
          );
        })}
      </div>

      {/* ── 二级：模型详情 ── */}
      <div className="model-detail">
        {!activePlatform ? (
          <div className="config-hint">请在左侧选择一个平台，或点击 ＋ 添加新平台。</div>
        ) : (
          <>
            <div className="model-detail-header">
              <h4>{activePlatform.name}</h4>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={async () => { setSyncing(true); try { await onSync(activePlatform); } finally { setSyncing(false); } }} disabled={syncing}>{syncing ? '同步中…' : '同步模型'}</button>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    onRemove(activePlatform.id);
                    setSelectedId(null);
                  }}
                >
                  删除平台
                </button>
              </div>
            </div>

            <div className="model-detail-info">
              <span className="muted-text">API: {activePlatform.apiBase || '未设置'}</span>
              <span className="muted-text">Key: {activePlatform.apiKey ? '••••••' : '未设置'}</span>
            </div>

            {activePlatform.models.length === 0 ? (
              <div className="config-hint" style={{ marginTop: 12 }}>
                暂无模型，请点击"同步模型"从 API 拉取模型列表。
              </div>
            ) : (
              <>
                <div className="model-list">
                  <div className="model-list-header">
                    <span>模型名称（勾选启用，可多选）</span>
                    <span>Agent</span>
                  </div>
                  {activePlatform.models.map((m) => {
                    const ref = `${activePlatform.name}::${m}`;
                    const isSelected = ref === agentChatModelId;
                    const enabled = activePlatform.selectedModels?.includes(m) ?? false;
                    return (
                      <div key={m} className={`model-list-row ${isSelected ? 'selected' : ''}`}>
                        <label className="model-list-name">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => toggleModel(activePlatform, m, e.target.checked)}
                          />
                          {m}
                          {isSelected && <span className="model-list-badge">当前</span>}
                        </label>
                        <input
                          type="radio"
                          title="设为当前 Agent 模型"
                          checked={isSelected}
                          onChange={() => onSelectModel(ref)}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* ── 每个已选模型的独立设置区 ── */}
                {(activePlatform.selectedModels ?? []).length > 0 && (
                  <div className="section" style={{ marginTop: 16 }}>
                    <h4>模型设置</h4>
                    {(activePlatform.selectedModels ?? []).map((m) => {
                      const settings = activePlatform.modelSettings?.[m];
                      // 未设置过的模型默认仅勾选文本
                      const caps: ModelCapabilities = settings?.capabilities ?? {
                        audio: false,
                        video: false,
                        image: false,
                        text: true,
                      };
                      return (
                        <div key={m} style={{ padding: '8px 0', borderTop: '1px solid var(--border-color, #333)' }}>
                          <div style={{ fontWeight: 600, marginBottom: 6 }}>{m}</div>
                          <label className="field-label">上下文大小（tokens）</label>
                          <input
                            type="number"
                            className="form-field"
                            placeholder={`默认 ${DEFAULT_CONTEXT_WINDOW}`}
                            value={settings?.contextWindow ?? ''}
                            onChange={(e) =>
                              patchModelSettings(activePlatform, m, {
                                contextWindow: parseInt(e.target.value) || 0,
                              })
                            }
                          />
                          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                            {(
                              [
                                ['audio', '音频'],
                                ['video', '视频'],
                                ['image', '图片'],
                                ['text', '文本'],
                              ] as Array<[keyof ModelCapabilities, string]>
                            ).map(([key, label]) => (
                              <label key={key} className="form-label" style={{ margin: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={caps[key]}
                                  onChange={(e) =>
                                    patchModelSettings(activePlatform, m, {
                                      capabilities: { ...caps, [key]: e.target.checked },
                                    })
                                  }
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {agentChatModelId ? (
          <div className="current-model">当前 Agent 模型：<strong>{agentChatModelId}</strong></div>
        ) : (
          <div className="warning-text" style={{ marginTop: 16 }}>未配置 Agent 模型，请选择一个模型后才能使用 Agent 功能。</div>
        )}
      </div>
    </div>
  );
}

/* ── 分析模型 Tab ─────────────────────────────────────── */

type AnalysisModelKey = 'speech' | 'video' | 'text';

const ANALYSIS_MODEL_FIELDS: Array<{ key: AnalysisModelKey; label: string; hint: string }> = [
  { key: 'speech', label: '语音分析模型', hint: '用于语音/音频内容分析' },
  { key: 'video', label: '视频分析模型', hint: '用于视频画面内容分析' },
  { key: 'text', label: '文本分析模型', hint: '用于文本内容分析' },
];

function AnalysisTab({
  config,
  onChange,
}: {
  config: ModelConfig;
  onChange: (patch: Partial<NonNullable<ModelConfig['analysisModels']>>) => void;
}): JSX.Element {
  // 所有平台已勾选模型组成的 平台名::模型名 选项
  const options = config.platforms.flatMap((p) =>
    (p.selectedModels ?? []).map((m) => {
      // 未设置能力的模型默认仅文本能力
      const caps = p.modelSettings?.[m]?.capabilities ?? { audio: false, video: false, image: false, text: true };
      return { ref: `${p.name}::${m}`, capabilities: caps };
    }),
  );

  return (
    <div className="section">
      <h4>分析模型</h4>
      {options.length === 0 ? (
        <div className="config-hint">
          暂无可选模型，请先在"模型配置"中勾选要启用的模型。
        </div>
      ) : (
        ANALYSIS_MODEL_FIELDS.map(({ key, label, hint }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label className="field-label">
              {label} <span className="muted-text">（{hint}）</span>
            </label>
            <select
              className="form-field"
              value={config.analysisModels?.[key] ?? ''}
              onChange={(e) => onChange({ [key]: e.target.value || undefined })}
            >
              <option value="">未设置</option>
              {options.map((o) => (
                <option key={o.ref} value={o.ref}>
                  {o.ref}
                  {key === 'video' && !o.capabilities.video ? ' ⚠无视频能力' : ''}
                </option>
              ))}
            </select>
          </div>
        ))
      )}
    </div>
  );
}

/* ── 对象存储 Tab ─────────────────────────────────────── */

function StorageTab(): JSX.Element {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    window.viewPoint.getStorageConfig().then((snap) => { if (snap?.config) setConfig(snap.config); });
  }, []);

  const update = (patch: Partial<StorageConfig>) => setConfig((c) => ({ ...(c ?? defaultStorage()), ...patch }));

  const save = async () => { if (config) { await window.viewPoint.saveStorageConfig(config); setTestResult('已保存'); } };
  const test = async () => {
    if (!config) return;
    setTesting(true);
    const res = await window.viewPoint.testStorageConnection(config);
    setTestResult(res?.success ? `✓ ${res.message}` : `✗ ${res?.message ?? '连接失败'}`);
    setTesting(false);
  };

  return (
    <>
      <div className="section">
        <h4>S3 兼容对象存储</h4>
        <input className="form-field" placeholder="Endpoint" value={config?.endpoint ?? ''} onChange={(e) => update({ endpoint: e.target.value })} />
        <input className="form-field" placeholder="Region（默认 us-east-1）" value={config?.region ?? ''} onChange={(e) => update({ region: e.target.value })} />
        <input className="form-field" placeholder="Bucket" value={config?.bucket ?? ''} onChange={(e) => update({ bucket: e.target.value })} />
        <input className="form-field" placeholder="Access Key ID" value={config?.accessKeyId ?? ''} onChange={(e) => update({ accessKeyId: e.target.value })} />
        <input className="form-field" placeholder="Secret Access Key" type="password" value={config?.secretAccessKey ?? ''} onChange={(e) => update({ secretAccessKey: e.target.value })} />
        <input className="form-field" placeholder="Public URL Base（留空则用预签名 URL）" value={config?.publicUrlBase ?? ''} onChange={(e) => update({ publicUrlBase: e.target.value })} />
        <input className="form-field" placeholder="文件目录（上传 key 前缀，默认 agent-outputs）" value={config?.directory ?? ''} onChange={(e) => update({ directory: e.target.value })} />
        <label className="form-label">
          <input type="checkbox" checked={config?.forcePathStyle ?? false} onChange={(e) => update({ forcePathStyle: e.target.checked })} />
          Force Path Style（MinIO 等需勾选）
        </label>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save}>保存</button>
          <button className="btn" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连接'}</button>
        </div>
        {testResult && (
          <div className={testResult.startsWith('✓') ? 'current-model' : 'warning-text'} style={{ marginTop: 12 }}>
            {testResult}
          </div>
        )}
      </div>
      {!config && <div className="warning-text">未配置对象存储，编辑工具产出上传将不可用。</div>}
    </>
  );
}

function defaultStorage(): StorageConfig {
  return { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', publicUrlBase: '', forcePathStyle: false, directory: '' };
}

/* ── 语音设置 Tab（语音合成 + 语音识别） ─────────────── */

const TTS_FORMATS = ['wav', 'mp3', 'pcm'];
const ASR_LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: '', label: '自动（跟随模型默认）' },
];

function VoiceTab(): JSX.Element {
  const [synthesis, setSynthesis] = useState<VoiceSynthesisConfig | null>(null);
  const [recognition, setRecognition] = useState<VoiceRecognitionConfig | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    window.viewPoint.getVoiceConfig().then((snap) => {
      setSynthesis(snap?.synthesis ?? null);
      setRecognition(snap?.recognition ?? null);
    });
  }, []);

  const patchSynthesis = (patch: Partial<VoiceSynthesisConfig>) =>
    setSynthesis((c) => ({ ...(c ?? DEFAULT_VOICE_SYNTHESIS), ...patch }));

  const patchRecognition = (patch: Partial<VoiceRecognitionConfig>) =>
    setRecognition((c) => ({ ...(c ?? DEFAULT_VOICE_RECOGNITION), ...patch }));

  const save = async () => {
    await window.viewPoint.saveVoiceConfig({
      synthesis: synthesis ?? undefined,
      recognition: recognition ?? undefined,
    });
    setSaved('已保存');
    setTimeout(() => setSaved(''), 2500);
  };

  return (
    <>
      <div className="section">
        <h4>语音合成（TTS）</h4>
        <label className="form-label">
          <input type="checkbox" checked={synthesis?.enabled ?? false} onChange={(e) => patchSynthesis({ enabled: e.target.checked })} />
          启用语音合成
        </label>
        <input className="form-field" placeholder="供应商（如 小米 MiMo、阿里云、OpenAI）" value={synthesis?.provider ?? ''} onChange={(e) => patchSynthesis({ provider: e.target.value })} />
        <input className="form-field" placeholder="API Base URL（如 https://api.xiaomimimo.com/v1）" value={synthesis?.apiBase ?? ''} onChange={(e) => patchSynthesis({ apiBase: e.target.value })} />
        <input className="form-field" placeholder="API Key" type="password" value={synthesis?.apiKey ?? ''} onChange={(e) => patchSynthesis({ apiKey: e.target.value })} />
        <input className="form-field" placeholder="模型（如 mimo-v2.5-tts、cosyvoice-v1）" value={synthesis?.model ?? ''} onChange={(e) => patchSynthesis({ model: e.target.value })} />
        <input className="form-field" placeholder="音色（如 Chloe）" value={synthesis?.voice ?? ''} onChange={(e) => patchSynthesis({ voice: e.target.value })} />
        <input className="form-field" placeholder="风格提示（可选，如：轻快活泼、语速快、句尾上扬）" value={synthesis?.style ?? ''} onChange={(e) => patchSynthesis({ style: e.target.value })} />
        <div className="voice-range-row">
          <label className="form-label">语速 <span className="muted-text">{synthesis?.speed ?? 1}</span></label>
          <input type="range" min={0.5} max={2} step={0.1} value={synthesis?.speed ?? 1} onChange={(e) => patchSynthesis({ speed: parseFloat(e.target.value) })} />
        </div>
        <div className="voice-range-row">
          <label className="form-label">音量 <span className="muted-text">{synthesis?.volume ?? 1}</span></label>
          <input type="range" min={0} max={1} step={0.05} value={synthesis?.volume ?? 1} onChange={(e) => patchSynthesis({ volume: parseFloat(e.target.value) })} />
        </div>
        <div className="voice-range-row">
          <label className="form-label">音调 <span className="muted-text">{synthesis?.pitch ?? 1}</span></label>
          <input type="range" min={0.5} max={2} step={0.1} value={synthesis?.pitch ?? 1} onChange={(e) => patchSynthesis({ pitch: parseFloat(e.target.value) })} />
        </div>
        <label className="form-label">输出格式</label>
        <select className="form-field" value={synthesis?.format ?? 'wav'} onChange={(e) => patchSynthesis({ format: e.target.value })}>
          {TTS_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div className="section">
        <h4>语音识别（ASR / STT）</h4>
        <label className="form-label">
          <input type="checkbox" checked={recognition?.enabled ?? false} onChange={(e) => patchRecognition({ enabled: e.target.checked })} />
          启用语音识别
        </label>
        <input className="form-field" placeholder="供应商（如 小米 MiMo、阿里云、OpenAI）" value={recognition?.provider ?? ''} onChange={(e) => patchRecognition({ provider: e.target.value })} />
        <input className="form-field" placeholder="API Base URL（如 https://api.xiaomimimo.com/v1）" value={recognition?.apiBase ?? ''} onChange={(e) => patchRecognition({ apiBase: e.target.value })} />
        <input className="form-field" placeholder="API Key" type="password" value={recognition?.apiKey ?? ''} onChange={(e) => patchRecognition({ apiKey: e.target.value })} />
        <input className="form-field" placeholder="模型（如 mimo-v2.5-asr、whisper-1）" value={recognition?.model ?? ''} onChange={(e) => patchRecognition({ model: e.target.value })} />
        <label className="form-label">识别语言</label>
        <select className="form-field" value={recognition?.language ?? 'zh'} onChange={(e) => patchRecognition({ language: e.target.value })}>
          {ASR_LANGUAGES.map((l) => <option key={l.value || 'auto'} value={l.value}>{l.label}</option>)}
        </select>
        <input className="form-field" type="number" placeholder="采样率（如 16000）" value={recognition?.sampleRate ?? 16000} onChange={(e) => patchRecognition({ sampleRate: parseInt(e.target.value) || 0 })} />
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={save}>保存语音设置</button>
      </div>
      {saved && <div className="current-model" style={{ marginTop: 8 }}>{saved}</div>}
    </>
  );
}
