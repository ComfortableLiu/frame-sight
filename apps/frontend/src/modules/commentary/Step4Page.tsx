import { useMemo, useState } from 'react';
import {
  Card,
  Button,
  Tag,
  Space,
  message,
  Modal,
  Typography,
  InputNumber,
  Switch,
  Input,
  ColorPicker,
} from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectScriptParts,
  patchSegment,
  setSubtitleSettings,
} from '../../store/commentarySlice.js';
import {
  getPartSegmentEntries,
  normalizeSegmentComposeKind,
  segmentKey,
  voiceKey,
} from '../../types/script.js';
import { runWithConcurrency } from './commentaryUtils.js';

const { Text } = Typography;

export function Step4Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const parts = useSelector(selectScriptParts);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [allLoading, setAllLoading] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [draft, setDraft] = useState(c.subtitleSettings);

  const items = useMemo(() => {
    const list: Array<{ partNumber: number; segmentIndex: number; segKey: string; voiceKey: string; voiceover: string }> = [];
    for (const part of parts) {
      const pn = Number(part.part_number);
      getPartSegmentEntries(part).forEach((s, idx) => {
        if (normalizeSegmentComposeKind(s.type, s) !== 'commentary') return;
        list.push({
          partNumber: pn,
          segmentIndex: idx,
          segKey: segmentKey(pn, idx),
          voiceKey: voiceKey(pn, idx),
          voiceover: s.voiceover || '',
        });
      });
    }
    return list;
  }, [parts]);

  const mergeOne = async (item: (typeof items)[number]) => {
    const seg = c.segments[item.segKey];
    const voice = c.voices[item.voiceKey];
    if (!seg?.outputPath || !voice?.outputPath) {
      throw new Error('缺少裁剪或配音产物');
    }
    if (!c.preparedId) throw new Error('缺少 preparedId');
    setBusy((s) => new Set(s).add(item.segKey));
    try {
      const merged = await window.viewPoint.mergeSegmentWithVoice({
        preparedId: c.preparedId,
        partNumber: item.partNumber,
        segmentIndex: item.segmentIndex,
        segmentPath: seg.outputPath,
        voicePath: voice.outputPath,
        inputPath: c.inputPath,
        startMs: seg.startMs,
      });
      dispatch(
        patchSegment({
          key: item.segKey,
          patch: {
            mergedOutputPath: merged.outputPath,
            mergedUrl: merged.outputUrl,
            mergedBaseOutputPath: merged.outputPath,
            mergedBaseUrl: merged.outputUrl,
          },
          invalidateDownstream: false,
        }),
      );
      const burned = await window.viewPoint.burnSubtitles({
        preparedId: c.preparedId,
        partNumber: item.partNumber,
        segmentIndex: item.segmentIndex,
        mergedVideoPath: merged.outputPath,
        voiceAudioPath: voice.outputPath,
        text: voice.text || item.voiceover,
        ...c.subtitleSettings,
      });
      dispatch(
        patchSegment({
          key: item.segKey,
          patch: {
            mergedOutputPath: burned.outputPath,
            mergedUrl: burned.url,
          },
          invalidateDownstream: false,
        }),
      );
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(item.segKey);
        return n;
      });
    }
  };

  const mergeAll = async () => {
    setAllLoading(true);
    const errors: string[] = [];
    await runWithConcurrency(items, 4, async (item) => {
      try {
        await mergeOne(item);
      } catch (err) {
        errors.push(`Part ${item.partNumber} 片段 #${item.segmentIndex + 1}: ${err instanceof Error ? err.message : err}`);
      }
    });
    setAllLoading(false);
    if (errors.length) errors.slice(0, 3).forEach((e) => message.error(e));
    else message.success('全部合并完成');
  };

  return (
    <Card
      title="合并解说与原片"
      extra={
        <Space>
          <Button onClick={() => { setDraft(c.subtitleSettings); setStyleOpen(true); }}>字幕样式</Button>
          <Button type="primary" loading={allLoading} onClick={mergeAll}>全部合并</Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {items.map((item) => {
          const seg = c.segments[item.segKey];
          const voice = c.voices[item.voiceKey];
          const missing = !seg?.outputPath || !voice?.outputPath;
          const done = Boolean(seg?.mergedUrl && seg?.mergedOutputPath);
          return (
            <Card key={item.segKey} size="small" type="inner"
              title={
                <Space>
                  Part {item.partNumber} · 片段 {String(item.segmentIndex + 1).padStart(2, '0')}
                  <Tag color="purple">解说</Tag>
                  <Tag color={done ? 'green' : missing ? 'default' : 'blue'}>
                    {done ? '已合并' : missing ? '缺前置产物' : '可合并'}
                  </Tag>
                </Space>
              }
              extra={
                <Button size="small" loading={busy.has(item.segKey)} disabled={missing} onClick={() => mergeOne(item)}>
                  合并解说
                </Button>
              }
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <Text type="secondary">{voice?.text || item.voiceover}</Text>
                {seg?.mergedUrl ? (
                  <video src={seg.mergedUrl} controls style={{ width: '100%', maxHeight: 220, background: '#000' }} />
                ) : null}
              </Space>
            </Card>
          );
        })}
      </Space>

      <Modal
        open={styleOpen}
        title="字幕样式"
        onCancel={() => setStyleOpen(false)}
        onOk={() => {
          dispatch(setSubtitleSettings({
            fontSize: draft.fontSize,
            fontColor: draft.fontColor,
            bold: draft.bold,
            outlineEnabled: draft.outlineEnabled,
            outlineSize: draft.outlineSize,
            outlineColor: draft.outlineColor,
            marginV: draft.marginV,
          }));
          setStyleOpen(false);
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Text>字号</Text>
            <InputNumber min={10} max={120} value={draft.fontSize} onChange={(v) => setDraft({ ...draft, fontSize: Number(v) || 28 })} />
            <Text>边距 MarginV</Text>
            <InputNumber min={0} max={400} value={draft.marginV} onChange={(v) => setDraft({ ...draft, marginV: Number(v) || 30 })} />
          </Space>
          <Space>
            <Text>字色</Text>
            <ColorPicker value={draft.fontColor} onChange={(c) => setDraft({ ...draft, fontColor: c.toHexString() })} />
            <Text>描边色</Text>
            <ColorPicker value={draft.outlineColor} onChange={(c) => setDraft({ ...draft, outlineColor: c.toHexString() })} />
          </Space>
          <Space>
            <Text>描边</Text>
            <Switch checked={draft.outlineEnabled} onChange={(v) => setDraft({ ...draft, outlineEnabled: v })} />
            <InputNumber min={0} max={20} value={draft.outlineSize} onChange={(v) => setDraft({ ...draft, outlineSize: Number(v) || 2 })} />
            <Text>加粗</Text>
            <Switch checked={draft.bold} onChange={(v) => setDraft({ ...draft, bold: v })} />
          </Space>
          <Input value={`MarginV=${draft.marginV} FontSize=${draft.fontSize}`} readOnly />
        </Space>
      </Modal>
    </Card>
  );
}
