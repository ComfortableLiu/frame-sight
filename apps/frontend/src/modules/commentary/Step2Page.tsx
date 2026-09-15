import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Tag, Space, message, Modal, InputNumber, Typography } from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectScriptParts,
  upsertSegment,
  patchSegment,
} from '../../store/commentarySlice.js';
import {
  getPartSegmentEntries,
  getSegmentTimeRange,
  normalizeSegmentComposeKind,
  segmentKey,
  formatMs,
} from '../../types/script.js';
import { runWithConcurrency } from './commentaryUtils.js';

const { Text } = Typography;

export function Step2Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const parts = useSelector(selectScriptParts);
  const [clippingAll, setClippingAll] = useState(false);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [tune, setTune] = useState<{ key: string; startMs: number; endMs: number } | null>(null);

  // 初始化 segments
  useEffect(() => {
    if (!parts.length) return;
    for (const part of parts) {
      const pn = Number(part.part_number);
      getPartSegmentEntries(part).forEach((s, idx) => {
        const key = segmentKey(pn, idx);
        const existing = c.segments[key];
        const range = getSegmentTimeRange(s);
        const kind = normalizeSegmentComposeKind(s.type, s);
        dispatch(
          upsertSegment({
            key,
            value: {
              partNumber: pn,
              segmentIndex: idx,
              startMs: existing?.startMs ?? range.startMs,
              endMs: existing?.endMs ?? range.endMs,
              status: existing?.status ?? 'idle',
              ...(kind === 'original_clip'
                ? { removeBackgroundAudio: existing?.removeBackgroundAudio ?? false }
                : {}),
            },
          }),
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts]);

  const clipOne = async (partNumber: number, segmentIndex: number) => {
    const key = segmentKey(partNumber, segmentIndex);
    if (!c.preparedId) {
      message.error('缺少 preparedId：请先在第 1 步上传并准备视频源');
      return;
    }
    const seg = c.segments[key];
    setBusyKeys((s) => new Set(s).add(key));
    dispatch(patchSegment({ key, patch: { status: 'clipping', error: undefined } }));
    try {
      const res = await window.viewPoint.clipSegmentEx({
        preparedId: c.preparedId,
        partNumber,
        segmentIndex,
        startMs: Math.max(0, Math.floor(seg?.startMs ?? 0)),
        endMs: Math.max(0, Math.floor(seg?.endMs ?? 0)),
        inputPath: c.inputPath,
      });
      dispatch(
        patchSegment({
          key,
          patch: {
            status: 'done',
            outputPath: res.outputPath,
            segmentUrl: res.segmentUrl,
            error: undefined,
          },
          invalidateDownstream: false,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch(patchSegment({ key, patch: { status: 'error', error: msg }, invalidateDownstream: false }));
      throw err;
    } finally {
      setBusyKeys((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const clipAll = async () => {
    const jobs: Array<{ partNumber: number; segmentIndex: number }> = [];
    for (const part of parts) {
      const pn = Number(part.part_number);
      getPartSegmentEntries(part).forEach((_, idx) => jobs.push({ partNumber: pn, segmentIndex: idx }));
    }
    setClippingAll(true);
    const errors: string[] = [];
    await runWithConcurrency(jobs, 4, async (job) => {
      try {
        await clipOne(job.partNumber, job.segmentIndex);
      } catch (err) {
        errors.push(`Part ${job.partNumber} 片段 #${job.segmentIndex + 1}: ${err instanceof Error ? err.message : err}`);
      }
    });
    setClippingAll(false);
    if (errors.length) errors.slice(0, 5).forEach((e) => message.error(e));
    else message.success('全部裁剪完成');
  };

  return (
    <Card
      title="裁剪原视频片段"
      extra={
        <Button type="primary" loading={clippingAll} onClick={clipAll} disabled={!parts.length}>
          全部裁剪
        </Button>
      }
    >
      {!parts.length ? (
        <Text type="secondary">请先在第 1 步生成脚本</Text>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {parts.map((part) => {
            const pn = Number(part.part_number);
            const entries = getPartSegmentEntries(part);
            return (
              <Card key={pn} size="small" title={part.part_title || part.content_title || `Part ${pn}`}>
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
                            <Tag>{seg?.status || 'idle'}</Tag>
                          </Space>
                        }
                        extra={
                          <Space>
                            <Button
                              size="small"
                              loading={busyKeys.has(key) || seg?.status === 'clipping'}
                              onClick={() => clipOne(pn, idx)}
                            >
                              {seg?.status === 'done' ? '重新裁剪' : '裁剪'}
                            </Button>
                            <Button
                              size="small"
                              onClick={() =>
                                setTune({ key, startMs: seg?.startMs ?? 0, endMs: seg?.endMs ?? 0 })
                              }
                            >
                              微调
                            </Button>
                          </Space>
                        }
                      >
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Text type="secondary" ellipsis>
                            {s.description || s.voiceover || ''}
                          </Text>
                          <Text type="secondary">
                            {formatMs(seg?.startMs ?? 0)} → {formatMs(seg?.endMs ?? 0)}
                          </Text>
                          {seg?.error ? <Text type="danger">{seg.error}</Text> : null}
                          {seg?.status === 'done' && seg.segmentUrl ? (
                            <video src={seg.segmentUrl} controls style={{ width: '100%', maxHeight: 200, background: '#000' }} />
                          ) : null}
                        </Space>
                      </Card>
                    );
                  })}
                </Space>
              </Card>
            );
          })}
        </Space>
      )}

      <Modal
        open={!!tune}
        title="微调片段时间（毫秒）"
        onCancel={() => setTune(null)}
        onOk={() => {
          if (!tune) return;
          dispatch(
            patchSegment({
              key: tune.key,
              patch: { startMs: tune.startMs, endMs: tune.endMs },
            }),
          );
          setTune(null);
        }}
      >
        {tune ? (
          <Space direction="vertical">
            <Space>
              <Text>开始</Text>
              <Button size="small" onClick={() => setTune({ ...tune, startMs: Math.max(0, tune.startMs - 200) })}>-200</Button>
              <InputNumber value={tune.startMs} onChange={(v) => setTune({ ...tune, startMs: Number(v) || 0 })} />
              <Button size="small" onClick={() => setTune({ ...tune, startMs: tune.startMs + 200 })}>+200</Button>
            </Space>
            <Space>
              <Text>结束</Text>
              <Button size="small" onClick={() => setTune({ ...tune, endMs: Math.max(0, tune.endMs - 200) })}>-200</Button>
              <InputNumber value={tune.endMs} onChange={(v) => setTune({ ...tune, endMs: Number(v) || 0 })} />
              <Button size="small" onClick={() => setTune({ ...tune, endMs: tune.endMs + 200 })}>+200</Button>
            </Space>
            {c.segments[tune.key]?.segmentUrl ? (
              <video
                className="tune-video"
                src={c.segments[tune.key].segmentUrl}
                controls
                style={{ width: '100%', maxHeight: 240, background: '#000' }}
              />
            ) : null}
            <Space wrap>
              <Button
                size="small"
                onClick={() => {
                  const v = document.querySelector<HTMLVideoElement>('.tune-video');
                  if (v) setTune({ ...tune, startMs: Math.floor(v.currentTime * 1000) });
                }}
              >
                用当前帧设为开始
              </Button>
              <Button
                size="small"
                onClick={() => {
                  const v = document.querySelector<HTMLVideoElement>('.tune-video');
                  if (v) setTune({ ...tune, endMs: Math.floor(v.currentTime * 1000) });
                }}
              >
                用当前帧设为结束
              </Button>
              <Button
                size="small"
                onClick={() => {
                  const v = document.querySelector<HTMLVideoElement>('.tune-video');
                  if (v) {
                    v.currentTime = tune.startMs / 1000;
                    void v.play();
                  }
                }}
              >
                从开始点播放
              </Button>
            </Space>
          </Space>
        ) : null}
      </Modal>
    </Card>
  );
}
