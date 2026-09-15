import { useMemo, useState } from 'react';
import { Card, Button, Tag, Space, message, Input, Slider, Select, Empty, Typography } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectScriptParts,
  upsertVoice,
  patchVoice,
  setVoiceSettings,
} from '../../store/commentarySlice.js';
import {
  getPartSegmentEntries,
  normalizeSegmentComposeKind,
  voiceKey,
} from '../../types/script.js';
import { runWithConcurrency } from './commentaryUtils.js';

const { Text } = Typography;

export function Step3Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const parts = useSelector(selectScriptParts);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [allLoading, setAllLoading] = useState(false);

  const items = useMemo(() => {
    const list: Array<{ partNumber: number; segmentIndex: number; voiceover: string; key: string }> = [];
    for (const part of parts) {
      const pn = Number(part.part_number);
      getPartSegmentEntries(part).forEach((s, idx) => {
        if (normalizeSegmentComposeKind(s.type, s) !== 'commentary') return;
        const vo = (s.voiceover || '').trim();
        if (!vo) return;
        list.push({ partNumber: pn, segmentIndex: idx, voiceover: vo, key: voiceKey(pn, idx) });
      });
    }
    return list;
  }, [parts]);

  const generateOne = async (item: { partNumber: number; segmentIndex: number; voiceover: string; key: string }) => {
    if (!c.preparedId) {
      message.error('缺少 preparedId：请先准备视频源');
      return;
    }
    const existing = c.voices[item.key];
    const text = existing?.text ?? item.voiceover;
    setBusy((s) => new Set(s).add(item.key));
    dispatch(
      upsertVoice({
        key: item.key,
        value: {
          partNumber: item.partNumber,
          segmentIndex: item.segmentIndex,
          text,
          voiceId: c.voiceSettings.voiceId,
          speed: c.voiceSettings.speed,
          status: 'generating',
          error: undefined,
        },
      }),
    );
    try {
      const res = await window.viewPoint.generateVoice({
        preparedId: c.preparedId,
        partNumber: item.partNumber,
        segmentIndex: item.segmentIndex,
        text,
        voiceId: c.voiceSettings.voiceId,
        speed: c.voiceSettings.speed,
      });
      dispatch(
        patchVoice({
          key: item.key,
          patch: {
            status: 'done',
            outputPath: res.outputPath,
            audioUrl: res.audioUrl,
            version: (existing?.version ?? 0) + 1,
            error: undefined,
          },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch(patchVoice({ key: item.key, patch: { status: 'error', error: msg } }));
      throw err;
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(item.key);
        return n;
      });
    }
  };

  const generateAll = async () => {
    if (!items.length) {
      message.warning('脚本里没有可合成的解说台词');
      return;
    }
    setAllLoading(true);
    const errors: string[] = [];
    await runWithConcurrency(items, 5, async (item) => {
      try {
        await generateOne(item);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    });
    setAllLoading(false);
    if (errors.length) message.error(errors[0]);
    else message.success('全部语音合成完成');
  };

  return (
    <Card
      title="生成解说语音片段"
      extra={<Button type="primary" loading={allLoading} onClick={generateAll}>一键合成全部语音</Button>}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Text>音色</Text>
          <Select
            style={{ minWidth: 220 }}
            placeholder="在设置中配置后选择"
            value={c.voiceSettings.voiceId || undefined}
            onChange={(v) => dispatch(setVoiceSettings({ voiceId: v }))}
            options={[{ label: '使用设置中的默认音色', value: 'default' }]}
            allowClear
          />
          <Text>语速</Text>
          <Slider style={{ width: 140 }} min={0.5} max={2} step={0.1} value={c.voiceSettings.speed}
            onChange={(v) => dispatch(setVoiceSettings({ speed: v }))} />
        </Space>
        {!items.length ? (
          <Empty description="没有可合成的解说台词" />
        ) : (
          parts.map((part) => {
            const pn = Number(part.part_number);
            const partItems = items.filter((x) => x.partNumber === pn);
            if (!partItems.length) return null;
            return (
              <Card key={pn} size="small" title={part.part_title || `Part ${pn}`}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {partItems.map((item) => {
                    const v = c.voices[item.key];
                    return (
                      <Card key={item.key} size="small" type="inner"
                        title={
                          <Space>
                            片段 {String(item.segmentIndex + 1).padStart(2, '0')}
                            <Tag color="purple">解说</Tag>
                            <Tag>{v?.status || 'idle'}</Tag>
                          </Space>
                        }
                        extra={
                          <Button size="small" loading={busy.has(item.key)} onClick={() => generateOne(item)}>
                            合成
                          </Button>
                        }
                      >
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Input.TextArea
                            rows={2}
                            value={v?.text ?? item.voiceover}
                            onChange={(e) =>
                              dispatch(
                                upsertVoice({
                                  key: item.key,
                                  value: {
                                    partNumber: item.partNumber,
                                    segmentIndex: item.segmentIndex,
                                    text: e.target.value,
                                    voiceId: c.voiceSettings.voiceId,
                                    speed: c.voiceSettings.speed,
                                    status: v?.status ?? 'idle',
                                  },
                                }),
                              )
                            }
                          />
                          {v?.error ? <Text type="danger">{v.error}</Text> : null}
                          {v?.status === 'done' && v.audioUrl ? (
                            <audio controls src={`${v.audioUrl}${v.audioUrl.includes('?') ? '&' : '?'}v=${v.version || 1}`} style={{ width: '100%' }} />
                          ) : null}
                        </Space>
                      </Card>
                    );
                  })}
                </Space>
              </Card>
            );
          })
        )}
      </Space>
    </Card>
  );
}
