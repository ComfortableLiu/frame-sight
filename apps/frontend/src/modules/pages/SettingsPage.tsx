import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectAgentChatModelId, setAgentChatModel } from '../../store/flowSlice.js';
import {
  selectModelConfig,
  setModelConfig,
  upsertPlatform,
  removePlatform,
  setContextWindow,
} from '../../store/modelConfigSlice.js';
import type { ModelPlatform, StorageConfig } from '../../types/modelConfig.js';
import { PLATFORM_TEMPLATES } from '../../utils/llmModels.js';
import { useRouter } from '../router/Router.js';

export function SettingsPage(): JSX.Element {
  const dispatch = useDispatch();
  const { back } = useRouter();
  const modelConfig = useSelector(selectModelConfig);
  const agentChatModelId = useSelector(selectAgentChatModelId);
  const [tab, setTab] = useState<'model' | 'storage'>('model');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 200; i++) {
        if (cancelled) return;
        const vp = (window as unknown as Record<string, unknown>).viewPoint;
        if (vp && typeof vp === 'object' && typeof (vp as Record<string, unknown>).getModelConfig === 'function') {
          try {
            const config = await (vp as Record<string, Function>).getModelConfig();
            if (!cancelled && config?.platforms) dispatch(setModelConfig(config));
          } catch { /* ignore */ }
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [dispatch]);

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
            className={`settings-nav-item ${tab === 'storage' ? 'active' : ''}`}
            onClick={() => setTab('storage')}
          >
            <span className="nav-icon">☁️</span>
            对象存储
          </button>
        </nav>

        <div className="settings-body">
          {!ready ? (
            <div className="settings-loading">加载中…</div>
          ) : tab === 'model' ? (
            <ModelTab
              platforms={modelConfig?.platforms ?? []}
              agentChatModelId={agentChatModelId}
              onAdd={(p) => {
                dispatch(upsertPlatform(p));
                window.viewPoint.saveModelConfig({ platforms: [...(modelConfig?.platforms ?? []), p] });
              }}
              onRemove={(id) => {
                dispatch(removePlatform(id));
                window.viewPoint.saveModelConfig({ platforms: (modelConfig?.platforms ?? []).filter((p) => p.id !== id) });
              }}
              onSync={async () => {
                const updated = await window.viewPoint.getModelConfig();
                if (updated?.platforms) dispatch(setModelConfig(updated));
              }}
              onSelectModel={(ref) => dispatch(setAgentChatModel(ref))}
              onSetContextWindow={(platformId, modelName, cw) =>
                dispatch(setContextWindow({ platformId, modelName, contextWindow: cw }))
              }
            />
          ) : (
            <StorageTab />
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
  onSetContextWindow,
}: {
  platforms: ModelPlatform[];
  agentChatModelId: string;
  onAdd: (p: ModelPlatform) => void;
  onRemove: (id: string) => void;
  onSync: (p: ModelPlatform) => void;
  onSelectModel: (ref: string) => void;
  onSetContextWindow: (platformId: string, modelName: string, cw: number) => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [apiBase, setApiBase] = useState('');
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
                <button className="btn" onClick={() => onSync(activePlatform)}>同步模型</button>
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
              <div className="model-list">
                <div className="model-list-header">
                  <span>模型名称</span>
                  <span>Context Window</span>
                </div>
                {activePlatform.models.map((m) => {
                  const ref = `${activePlatform.name}::${m}`;
                  const isSelected = ref === agentChatModelId;
                  return (
                    <div key={m} className={`model-list-row ${isSelected ? 'selected' : ''}`}>
                      <label className="model-list-name">
                        <input
                          type="radio"
                          checked={isSelected}
                          onChange={() => onSelectModel(ref)}
                        />
                        {m}
                        {isSelected && <span className="model-list-badge">当前</span>}
                      </label>
                      <input
                        type="number"
                        className="cw-input"
                        placeholder="如 128000"
                        value={activePlatform.contextWindows?.[m] ?? ''}
                        onChange={(e) => onSetContextWindow(activePlatform.id, m, parseInt(e.target.value) || 0)}
                      />
                    </div>
                  );
                })}
              </div>
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
  return { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', publicUrlBase: '', forcePathStyle: false };
}
