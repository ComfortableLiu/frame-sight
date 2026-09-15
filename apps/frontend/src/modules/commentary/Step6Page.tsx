import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  Button,
  Space,
  Typography,
  Input,
  Slider,
  Switch,
  Select,
  message,
  ColorPicker,
} from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectScriptParts,
  setStep6Config,
  setStep6Output,
  upsertStep6Preset,
  removeStep6Preset,
  setStep6SelectedPresetId,
} from '../../store/commentarySlice.js';
import type { Step6TextItem } from '../../store/commentarySlice.js';

const { Text } = Typography;
const PREVIEW_W = 320;

export function Step6Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const parts = useSelector(selectScriptParts);
  const [selectedId, setSelectedId] = useState('');
  const [composing, setComposing] = useState(false);
  const [presetAlias, setPresetAlias] = useState('');
  const [fonts, setFonts] = useState<Array<{ id: string; alias: string; filePath: string }>>([]);
  const [videoRatio, setVideoRatio] = useState(16 / 9);

  const config = c.step6Configs['1'] || {
    coverImagePath: '',
    coverImageUrl: '',
    forcePortrait: true,
    texts: [] as Step6TextItem[],
  };
  const part1 = parts[0];
  const final1 = c.finalParts['1'];
  const canCompose = Boolean(final1?.outputPath);
  const forcePortrait = config.forcePortrait !== false;

  useEffect(() => {
    window.viewPoint.listCustomFonts().then((res) => {
      setFonts(res.items || []);
    }).catch(() => undefined);
  }, []);

  const fontOptions = useMemo(
    () => fonts.map((f) => ({ label: f.alias, value: f.id })),
    [fonts],
  );

  const applyConfig = (patch: Partial<typeof config>) => {
    dispatch(setStep6Config({ partNumber: 1, patch }));
  };

  const containerH = forcePortrait ? (PREVIEW_W * 16) / 9 : PREVIEW_W / (videoRatio || 16 / 9);

  const selected = config.texts.find((t) => t.id === selectedId);

  const addText = (centered: boolean) => {
    const item: Step6TextItem = {
      id: `t_${Date.now()}`,
      text: '输入文字',
      fontSize: 42,
      color: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 0,
      bold: false,
      xPercent: centered ? 50 : 18,
      yPercent: centered ? 50 : 18,
      fontFamily: fonts[0]?.id || 'system',
    };
    applyConfig({ texts: [...config.texts, item] });
    setSelectedId(item.id);
  };

  const compose = async () => {
    if (!final1?.outputPath) {
      message.error('请先在第五步生成该短视频');
      return;
    }
    setComposing(true);
    try {
      const res = await window.viewPoint.composeCoverVideo({
        inputPath: final1.outputPath,
        coverImagePath: config.coverImagePath || undefined,
        forcePortrait,
        videoBitrateKbps: c.composeAudioSettings.finalVideoBitrateKbps,
        texts: config.texts.map((t) => ({ ...t, text: t.text.replace(/\s+/g, ' ').trim() })),
      });
      dispatch(setStep6Output({ partNumber: 1, outputPath: res.outputPath, finalUrl: res.finalUrl }));
      message.success('第六步合成完成');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setComposing(false);
    }
  };

  return (
    <Card
      title="文字与封面合成"
      extra={
        <Space>
          <Button onClick={() => { setPresetAlias(''); }}>预设</Button>
          <Button type="primary" loading={composing} disabled={!canCompose} onClick={compose}>
            合成第六步成品
          </Button>
          <Button
            disabled={!c.step6Outputs['1']?.outputPath}
            onClick={async () => {
              const out = c.step6Outputs['1'];
              if (!out) return;
              const res = await window.viewPoint.exportPartVideo({
                outputPath: out.outputPath,
                defaultFileName: 'part_1_cover.mp4',
              });
              if (!res.canceled) message.success('已导出');
            }}
          >
            导出
          </Button>
        </Space>
      }
    >
      <Space size={24} align="start" wrap>
        <div
          style={{
            width: PREVIEW_W,
            height: containerH,
            background: '#000',
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 8,
          }}
        >
          {final1?.finalUrl ? (
            <video
              src={final1.finalUrl}
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
              onLoadedData={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setVideoRatio(v.videoWidth / v.videoHeight);
                v.currentTime = 0.06;
                v.pause();
              }}
            />
          ) : (
            <div style={{ color: '#666', padding: 24, fontSize: 12 }}>请先完成第五步</div>
          )}
          {config.texts.map((t) => {
            const scale = PREVIEW_W / 1080;
            const fontSize = Math.max(1, Math.round(t.fontSize * scale));
            return (
              <div
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                style={{
                  position: 'absolute',
                  left: `${t.xPercent}%`,
                  top: `${t.yPercent}%`,
                  color: t.color,
                  fontSize,
                  fontWeight: t.bold ? 700 : 400,
                  WebkitTextStroke: t.outlineWidth > 0 ? `${Math.max(0.5, t.outlineWidth * scale)}px ${t.outlineColor}` : undefined,
                  paintOrder: 'stroke fill',
                  whiteSpace: 'nowrap',
                  outline: selectedId === t.id ? '1px dashed #fff' : undefined,
                  outlineOffset: 4,
                  cursor: 'pointer',
                  fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif',
                }}
              >
                {t.text}
              </div>
            );
          })}
        </div>

        <Space direction="vertical" style={{ minWidth: 360 }} size={12}>
          <Space>
            <Button onClick={() => addText(true)}>添加居中文字</Button>
            <Button onClick={() => addText(false)}>添加文字</Button>
            <Button
              onClick={async () => {
                const res = await window.viewPoint.pickImageFile();
                if (res.canceled || !res.filePath) return;
                applyConfig({ coverImagePath: res.filePath, coverImageUrl: res.previewUrl || '' });
              }}
            >
              选择封面图
            </Button>
            <Switch
              checkedChildren="强制竖屏"
              unCheckedChildren="原比例"
              checked={forcePortrait}
              onChange={(v) => applyConfig({ forcePortrait: v })}
            />
          </Space>
          {config.coverImagePath ? (
            <Text type="secondary">封面：{config.coverImagePath}</Text>
          ) : null}
          {part1 ? (
            <Text type="secondary">
              标题：{part1.content_title || part1.part_title || '-'}
            </Text>
          ) : null}

          {selected ? (
            <Card size="small" title="编辑文字">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input
                  value={selected.text}
                  onChange={(e) => {
                    const text = e.target.value.replace(/\n/g, '');
                    applyConfig({
                      texts: config.texts.map((t) => (t.id === selected.id ? { ...t, text } : t)),
                    });
                  }}
                />
                <Select
                  style={{ width: '100%' }}
                  options={fontOptions}
                  value={selected.fontFamily}
                  onChange={(v) =>
                    applyConfig({
                      texts: config.texts.map((t) => (t.id === selected.id ? { ...t, fontFamily: v } : t)),
                    })
                  }
                />
                <Space>
                  <Text>字号</Text>
                  <Slider
                    style={{ width: 140 }}
                    min={12}
                    max={180}
                    value={selected.fontSize}
                    onChange={(v) =>
                      applyConfig({
                        texts: config.texts.map((t) => (t.id === selected.id ? { ...t, fontSize: v } : t)),
                      })
                    }
                  />
                  <Text>描边</Text>
                  <Slider
                    style={{ width: 100 }}
                    min={0}
                    max={12}
                    value={selected.outlineWidth}
                    onChange={(v) =>
                      applyConfig({
                        texts: config.texts.map((t) => (t.id === selected.id ? { ...t, outlineWidth: v } : t)),
                      })
                    }
                  />
                </Space>
                <Space>
                  <ColorPicker
                    value={selected.color}
                    onChange={(col) =>
                      applyConfig({
                        texts: config.texts.map((t) =>
                          t.id === selected.id ? { ...t, color: col.toHexString() } : t,
                        ),
                      })
                    }
                  />
                  <Button
                    size="small"
                    onClick={() =>
                      applyConfig({
                        texts: config.texts.map((t) =>
                          t.id === selected.id ? { ...t, bold: !t.bold } : t,
                        ),
                      })
                    }
                  >
                    {selected.bold ? '取消加粗' : '加粗'}
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      applyConfig({ texts: config.texts.filter((t) => t.id !== selected.id) });
                      setSelectedId('');
                    }}
                  >
                    删除
                  </Button>
                </Space>
                <Text type="secondary">当前 X：{Math.round(selected.xPercent)}%，Y：{Math.round(selected.yPercent)}%</Text>
              </Space>
            </Card>
          ) : null}

          <Card size="small" title="预设历史">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Input placeholder="预设别名" value={presetAlias} onChange={(e) => setPresetAlias(e.target.value)} />
                <Button
                  onClick={() => {
                    if (!presetAlias.trim()) {
                      message.warning('请输入别名');
                      return;
                    }
                    dispatch(
                      upsertStep6Preset({
                        id: c.step6SelectedPresetId || undefined,
                        alias: presetAlias.trim(),
                        config,
                      }),
                    );
                    message.success('已保存预设');
                  }}
                >
                  保存当前
                </Button>
              </Space>
              <Select
                allowClear
                style={{ width: '100%' }}
                placeholder="选择历史预设"
                value={c.step6SelectedPresetId || undefined}
                options={c.step6PresetHistory.map((p) => ({ label: p.alias, value: p.id }))}
                onChange={(v) => {
                  dispatch(setStep6SelectedPresetId(v || ''));
                  const found = c.step6PresetHistory.find((p) => p.id === v);
                  if (found) applyConfig(found.config);
                }}
              />
              {c.step6SelectedPresetId ? (
                <Button
                  size="small"
                  danger
                  onClick={() => dispatch(removeStep6Preset(c.step6SelectedPresetId))}
                >
                  删除历史
                </Button>
              ) : null}
            </Space>
          </Card>
        </Space>
      </Space>
    </Card>
  );
}
