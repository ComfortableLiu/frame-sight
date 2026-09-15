import { useState } from 'react';
import {
  Card,
  Button,
  Space,
  Select,
  Modal,
  Slider,
  Input,
  Switch,
  message,
  Progress,
  Typography,
  Tag,
} from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectScriptParts,
  setComposeAudioSettings,
  setFinalPart,
  addWatermarkHistory,
  patchSegment,
} from '../../store/commentarySlice.js';
import {
  getPartSegmentEntries,
  normalizeSegmentComposeKind,
  segmentKey,
} from '../../types/script.js';

const { Text } = Typography;

export function Step5Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const parts = useSelector(selectScriptParts);
  const [composing, setComposing] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progress, setProgress] = useState<{ step?: string; ratio?: number; status?: string } | null>(null);
  const [bgmOpen, setBgmOpen] = useState(false);
  const [wmOpen, setWmOpen] = useState(false);

  const composePart = async (partNumber: number, scriptPart: (typeof parts)[number]) => {
    const entries = getPartSegmentEntries(scriptPart);
    const composeItems: Array<{ videoPath: string; type: 'commentary' | 'original_clip'; removeBackgroundAudio?: boolean }> = [];
    let prevEnd: number | null = null;

    for (let idx = 0; idx < entries.length; idx++) {
      const s = entries[idx];
      const key = segmentKey(partNumber, idx);
      const seg = c.segments[key];
      const kind = normalizeSegmentComposeKind(s.type, s);
      let startMs = Number(seg?.sourceStartMs ?? seg?.startMs ?? 0);
      const endMs = Number(seg?.sourceEndMs ?? seg?.endMs ?? 0);
      let alignedStart = startMs;
      if (prevEnd != null && Number.isFinite(startMs)) {
        const gap = startMs - prevEnd;
        if (gap > 0 && gap <= 1000) alignedStart = prevEnd;
      }
      if (alignedStart !== startMs) {
        dispatch(
          patchSegment({
            key,
            patch: { startMs: Math.floor(alignedStart), sourceStartMs: Math.floor(alignedStart) },
            invalidateDownstream: false,
          }),
        );
        startMs = alignedStart;
      }
      if (kind === 'commentary') {
        if (seg?.mergedOutputPath) {
          composeItems.push({ videoPath: seg.mergedOutputPath, type: 'commentary' });
        } else {
          message.warning(`片段 ${idx + 1} 的解说视频尚未合成，已跳过`);
        }
      } else if (seg?.outputPath) {
        composeItems.push({
          videoPath: seg.outputPath,
          type: 'original_clip',
          removeBackgroundAudio: seg.removeBackgroundAudio ?? false,
        });
      } else {
        message.warning(`片段 ${idx + 1} 的原视频裁剪尚未完成，已跳过`);
      }
      if (Number.isFinite(endMs)) {
        dispatch(
          patchSegment({
            key,
            patch: { sourceStartMs: Math.floor(startMs), sourceEndMs: Math.floor(Math.max(startMs, endMs)) },
            invalidateDownstream: false,
          }),
        );
        prevEnd = Math.max(startMs, endMs);
      }
    }

    if (!composeItems.length) {
      message.error('没有可用于合成的片段');
      return;
    }

    setComposing(true);
    setProgressOpen(true);
    const poll = setInterval(async () => {
      try {
        const st = await window.viewPoint.composeProgressStatus();
        setProgress(st);
      } catch {
        // ignore
      }
    }, 500);
    try {
      const res = await window.viewPoint.composePartVideoEx({
        preparedId: c.preparedId,
        partNumber,
        segments: composeItems,
        backgroundMusicPath: c.composeAudioSettings.backgroundMusicPath || undefined,
        backgroundMusicVolume: c.composeAudioSettings.backgroundMusicVolume,
        originalClipVolume: c.composeAudioSettings.originalClipVolume,
        vocalIsolationMix: c.composeAudioSettings.vocalIsolationMix,
        watermarkText: c.composeAudioSettings.watermarkEnabled && c.composeAudioSettings.watermarkText?.trim()
          ? c.composeAudioSettings.watermarkText.trim()
          : undefined,
        watermarkOpacity: c.composeAudioSettings.watermarkOpacity,
        watermarkFontSize: c.composeAudioSettings.watermarkFontSize,
        forcedAspectRatio: c.composeAudioSettings.forcedAspectRatio,
        videoBitrateKbps: c.composeAudioSettings.finalVideoBitrateKbps,
      });
      const version = Date.now();
      if (c.composeAudioSettings.watermarkEnabled && c.composeAudioSettings.watermarkText?.trim()) {
        dispatch(
          addWatermarkHistory({
            text: c.composeAudioSettings.watermarkText.trim(),
            opacity: c.composeAudioSettings.watermarkOpacity,
            fontSize: c.composeAudioSettings.watermarkFontSize,
          }),
        );
      }
      dispatch(
        setFinalPart({
          partNumber,
          outputPath: res.outputPath,
          finalUrl: `${res.finalUrl}${res.finalUrl.includes('?') ? '&' : '?'}v=${version}`,
        }),
      );
      message.success(`Part ${partNumber} 成片完成`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('cancel') || msg.includes('取消')) message.warning('合成已取消');
      else message.error(msg);
    } finally {
      clearInterval(poll);
      setComposing(false);
      setProgressOpen(false);
    }
  };

  const exportAll = async () => {
    const items = parts
      .map((p) => {
        const pn = Number(p.part_number);
        const fin = c.finalParts[String(pn)];
        if (!fin?.outputPath) return null;
        return {
          outputPath: fin.outputPath,
          fileName: `${(p.part_title || p.content_title || `part_${pn}`).replace(/[\\/:*?"<>|]/g, '_')}.mp4`,
        };
      })
      .filter(Boolean) as Array<{ outputPath: string; fileName: string }>;
    if (!items.length) {
      message.error('没有可导出的成片');
      return;
    }
    const res = await window.viewPoint.exportAllVideos({ items });
    if (!res.canceled) message.success('已导出成片到所选文件夹');
  };

  return (
    <Card
      title="合成成片视频"
      extra={
        <Space>
          <Button onClick={() => setBgmOpen(true)}>背景音乐设置</Button>
          <Button onClick={() => setWmOpen(true)}>水印设置</Button>
          <Button
            type="primary"
            loading={composing}
            onClick={async () => {
              for (const part of parts) {
                await composePart(Number(part.part_number), part);
              }
            }}
          >
            一键合成全部成品
          </Button>
          <Button onClick={exportAll}>一键导出全部作品</Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space>
          <Text>强制比例</Text>
          <Select
            style={{ width: 120 }}
            value={c.composeAudioSettings.forcedAspectRatio}
            onChange={(v) => dispatch(setComposeAudioSettings({ forcedAspectRatio: v }))}
            options={['source', '16:9', '4:3', '9:16', '3:4'].map((x) => ({
              label: x === 'source' ? '原比例' : x,
              value: x,
            }))}
          />
        </Space>
        {parts.map((part) => {
          const pn = Number(part.part_number);
          const fin = c.finalParts[String(pn)];
          const entries = getPartSegmentEntries(part);
          return (
            <Card
              key={pn}
              size="small"
              title={
                <Space>
                  {part.part_title || part.content_title || `Part ${pn}`}
                  {fin?.outputPath ? <Tag color="green">已合成成品</Tag> : null}
                </Space>
              }
              extra={
                <Button size="small" type="primary" loading={composing} onClick={() => composePart(pn, part)}>
                  合成该 Part
                </Button>
              }
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                {entries.map((s, idx) => {
                  const key = segmentKey(pn, idx);
                  const seg = c.segments[key];
                  const kind = normalizeSegmentComposeKind(s.type, s);
                  return (
                    <Card key={key} size="small" type="inner"
                      title={
                        <Space>
                          片段 {String(idx + 1).padStart(2, '0')}
                          <Tag color={kind === 'commentary' ? 'purple' : 'blue'}>
                            {kind === 'commentary' ? '解说' : '原片'}
                          </Tag>
                        </Space>
                      }
                      extra={
                        kind === 'original_clip' ? (
                          <Space>
                            <Switch
                              size="small"
                              checkedChildren="去背景音"
                              unCheckedChildren="保留背景音"
                              checked={seg?.removeBackgroundAudio ?? false}
                              onChange={(v) =>
                                dispatch(
                                  patchSegment({
                                    key,
                                    patch: { removeBackgroundAudio: v },
                                    invalidateDownstream: false,
                                  }),
                                )
                              }
                            />
                          </Space>
                        ) : null
                      }
                    >
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Text type="secondary">{s.description || s.voiceover || ''}</Text>
                        {seg?.segmentUrl ? (
                          <video src={seg.segmentUrl} controls style={{ width: '100%', maxHeight: 160, background: '#000' }} />
                        ) : null}
                      </Space>
                    </Card>
                  );
                })}
                {fin?.finalUrl ? (
                  <video src={fin.finalUrl} controls style={{ width: '100%', maxHeight: 320, background: '#000' }} />
                ) : null}
              </Space>
            </Card>
          );
        })}
      </Space>

      <Modal open={progressOpen} title="合成进度" footer={null} closable={false} maskClosable={false}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Progress percent={Math.round((progress?.ratio || 0) * 100)} status="active" />
          <Text>{progress?.step || '处理中…'} {progress?.status}</Text>
          <Button
            danger
            onClick={async () => {
              await window.viewPoint.composeProgressCancel();
              message.warning('已请求取消');
              setProgressOpen(false);
            }}
          >
            取消任务
          </Button>
        </Space>
      </Modal>

      <Modal open={bgmOpen} title="背景音乐设置" onCancel={() => setBgmOpen(false)} onOk={() => setBgmOpen(false)} width={640}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button
              onClick={async () => {
                const res = await window.viewPoint.pickAudioFile();
                if (res.canceled || !res.filePath) return;
                dispatch(
                  setComposeAudioSettings({
                    backgroundMusicPath: res.filePath,
                    backgroundMusicUrl: res.previewUrl || '',
                  }),
                );
              }}
            >
              选择背景音乐
            </Button>
            <Button onClick={() => dispatch(setComposeAudioSettings({ backgroundMusicPath: '', backgroundMusicUrl: '' }))}>
              清除
            </Button>
            <Text type="secondary">{c.composeAudioSettings.backgroundMusicPath || '未选择'}</Text>
          </Space>
          <Space>
            <Text>BGM 音量</Text>
            <Slider
              style={{ width: 180 }}
              min={0}
              max={1}
              step={0.01}
              value={c.composeAudioSettings.backgroundMusicVolume}
              onChange={(v) => dispatch(setComposeAudioSettings({ backgroundMusicVolume: v }))}
            />
            <Text>原片音量</Text>
            <Slider
              style={{ width: 180 }}
              min={0}
              max={1}
              step={0.01}
              value={c.composeAudioSettings.originalClipVolume}
              onChange={(v) => dispatch(setComposeAudioSettings({ originalClipVolume: v }))}
            />
          </Space>
          <Text type="secondary">启用背景音乐后，原片段可按开关处理人声再混音。</Text>
        </Space>
      </Modal>

      <Modal open={wmOpen} title="水印设置" onCancel={() => setWmOpen(false)} onOk={() => setWmOpen(false)} width={560}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Text>启用水印</Text>
            <Switch
              checked={c.composeAudioSettings.watermarkEnabled}
              onChange={(v) => dispatch(setComposeAudioSettings({ watermarkEnabled: v }))}
            />
          </Space>
          <Input.TextArea
            rows={2}
            maxLength={200}
            showCount
            placeholder="例如：@你的账号 · 仅供学习交流"
            value={c.composeAudioSettings.watermarkText}
            onChange={(e) => dispatch(setComposeAudioSettings({ watermarkText: e.target.value }))}
          />
          <Space>
            <Text>不透明度</Text>
            <Slider
              style={{ width: 160 }}
              min={0.06}
              max={0.45}
              step={0.01}
              value={c.composeAudioSettings.watermarkOpacity}
              onChange={(v) => dispatch(setComposeAudioSettings({ watermarkOpacity: v }))}
            />
            <Text>字号</Text>
            <Slider
              style={{ width: 120 }}
              min={12}
              max={96}
              value={c.composeAudioSettings.watermarkFontSize}
              onChange={(v) => dispatch(setComposeAudioSettings({ watermarkFontSize: v }))}
            />
          </Space>
        </Space>
      </Modal>
    </Card>
  );
}
