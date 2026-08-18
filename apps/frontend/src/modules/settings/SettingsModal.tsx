import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectAgentChatModelId,
  setAgentChatModel,
} from '../../store/flowSlice.js';
import {
  selectModelConfig,
  setModelConfig,
  upsertPlatform,
  removePlatform,
  setContextWindow,
} from '../../store/modelConfigSlice.js';
import type { ModelPlatform, StorageConfig } from '../../types/modelConfig.js';
import { PLATFORM_TEMPLATES } from '../../utils/llmModels.js';

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const dispatch = useDispatch();
  const modelConfig = useSelector(selectModelConfig);
  const agentChatModelId = useSelector(selectAgentChatModelId);
  const [tab, setTab] = useState<'model' | 'storage'>('model');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 轮询等待 viewPoint 真正就绪（最多 10s）
      for (let i = 0; i < 200; i++) {
        if (cancelled) return;
        const vp = (window as unknown as Record<string, unknown>).viewPoint;
        if (vp && typeof vp === 'object' && typeof (vp as Record<string, unknown>).getModelConfig === 'function') {
          try {
            const config = await (vp as Record<string, Function>).getModelConfig();
            if (!cancelled && config?.platforms) {
              dispatch(setModelConfig(config));
            }
          } catch {
            // 忽略
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!cancelled) setReady(true);
    }

    load();
    return () => { cancelled = true; };
  }, [dispatch]);

  if (!ready) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>设置</h3>
            <button className="btn-icon" onClick={onClose} style={{ fontSize: 20 }}>×</button>
          </div>
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            加载中…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>设置</h3>
          <button className="btn-icon" onClick={onClose} style={{ fontSize: 20 }}>×</button>
        </div>
        <div className="modal-tabs">
          <button
            className={`modal-tab ${tab === 'model' ? 'active' : ''}`}
            onClick={() => setTab('model')}
          >
            模型配置
          </button>
          <button
            className={`modal-tab ${tab === 'storage' ? 'active' : ''}`}
            onClick={() => setTab('storage')}
          >
            对象存储
          </button>
        </div>
        <div className="modal-body">
          {tab === 'model' ? (
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
              onSelectModel={(ref) => {
                dispatch(setAgentChatModel(ref));
              }}
              onSetContextWindow={(platformId, modelName, cw) => {
                dispatch(setContextWindow({ platformId, modelName, contextWindow: cw }));
              }}
            />
          ) : (
            <StorageTab />
          )}
        </div>
      </div>
    </div>
  );
}

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
  const [name, setName] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');

  const addPlatform = () => {
    if (!name) return;
    onAdd({
      id: crypto.randomUUID(),
      name,
      apiBase,
      apiKey,
      models: [],
      selectedModels: [],
      contextWindows: {},
    });
    setName('');
    setApiBase('');
    setApiKey('');
  };

  return (
    <>
      <div className="section">
        <h4>添加模型平台</h4>
        <select
          className="form-field"
          defaultValue=""
          onChange={(e) => {
            const tpl = PLATFORM_TEMPLATES.find((t) => t.name === e.target.value);
            if (tpl) { setName(tpl.name); setApiBase(tpl.apiBase); }
          }}
        >
          <option value="">选择模板…</option>
          {PLATFORM_TEMPLATES.map((t) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <input className="form-field" placeholder="平台别名" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="form-field" placeholder="API base URL" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
        <input className="form-field" placeholder="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <button className="btn btn-primary" onClick={addPlatform}>添加平台</button>
      </div>

      {platforms.length === 0 && (
        <div className="config-hint">还没有平台，请先添加一个模型平台，然后同步模型列表并选择 Agent 模型。</div>
      )}

      {platforms.map((p) => (
        <div key={p.id} className="platform-card">
          <div className="platform-header">
            <strong>{p.name}</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" onClick={() => onSync(p)}>同步模型</button>
              <button className="btn btn-danger" onClick={() => onRemove(p.id)}>删除</button>
            </div>
          </div>
          {p.models.length === 0 && (
            <div className="muted-text" style={{ padding: '6px 0' }}>点击"同步模型"获取列表</div>
          )}
          {p.models.map((m) => {
            const ref = `${p.name}::${m}`;
            const selected = ref === agentChatModelId;
            return (
              <div key={m} className="model-row">
                <label>
                  <input
                    type="radio"
                    checked={selected}
                    onChange={() => onSelectModel(ref)}
                  />
                  {m}
                </label>
                <input
                  type="number"
                  className="cw-input"
                  placeholder="context window"
                  value={p.contextWindows?.[m] ?? ''}
                  onChange={(e) => onSetContextWindow(p.id, m, parseInt(e.target.value) || 0)}
                />
              </div>
            );
          })}
        </div>
      ))}

      {agentChatModelId ? (
        <div className="current-model">
          当前 Agent 模型：<strong>{agentChatModelId}</strong>
        </div>
      ) : (
        <div className="warning-text">未配置 Agent 模型，请在上方选择一个模型后才能使用 Agent 功能。</div>
      )}
    </>
  );
}

function StorageTab(): JSX.Element {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    window.viewPoint.getStorageConfig().then((snap) => {
      if (snap?.config) setConfig(snap.config);
    });
  }, []);

  const save = async () => {
    if (!config) return;
    await window.viewPoint.saveStorageConfig(config);
    setTestResult('已保存');
  };

  const test = async () => {
    if (!config) return;
    setTesting(true);
    const res = await window.viewPoint.testStorageConnection(config);
    setTestResult(res?.success ? `✓ ${res.message}` : `✗ ${res?.message ?? '连接失败'}`);
    setTesting(false);
  };

  const update = (patch: Partial<StorageConfig>) => {
    setConfig((c) => ({ ...(c ?? defaultStorage()), ...patch }));
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
          <button className="btn" onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {testResult && (
          <div className={testResult.startsWith('✓') ? 'current-model' : 'warning-text'} style={{ marginTop: 12 }}>
            {testResult}
          </div>
        )}
      </div>
      {!config && (
        <div className="warning-text">未配置对象存储，编辑工具产出上传将不可用。</div>
      )}
    </>
  );
}

function defaultStorage(): StorageConfig {
  return { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', publicUrlBase: '', forcePathStyle: false, directory: '' };
}
