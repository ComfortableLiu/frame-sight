import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card,
  Button,
  Space,
  Typography,
  Select,
  InputNumber,
  Switch,
  message,
  Progress,
  Spin,
  Alert,
  Slider,
  Input,
} from 'antd';
import { UploadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  setLocalVideo,
  setPreparedSource,
  setCommentaryParams,
  setCompressSettings,
  setLlmModel,
  setVoiceSettings,
  setQuickGenerate,
  setScript,
} from '../../store/commentarySlice.js';
import { selectModelConfig, selectModelConfigLoaded, setModelConfig } from '../../store/modelConfigSlice.js';
import { store } from '../../store/index.js';
import { generateCommentaryScript } from './commentaryUtils.js';
import { getPartSegmentEntries, normalizeSegmentComposeKind, segmentKey, voiceKey, getSegmentTimeRange } from '../../types/script.js';
import { runWithConcurrency } from './commentaryUtils.js';
import { setCurrentStep } from '../../store/commentarySlice.js';

const { Text, Paragraph } = Typography;

function modelOptions(config: ReturnType<typeof selectModelConfig>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const p of config?.platforms || []) {
    for (const m of p.selectedModels?.length ? p.selectedModels : p.models || []) {
      out.push({ label: `${p.name} · ${m}`, value: `${p.name}::${m}` });
    }
  }
  return out;
}

export function Step1Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const modelConfig = useSelector(selectModelConfig);
  const modelConfigLoaded = useSelector(selectModelConfigLoaded);
  const [preparing, setPreparing] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [abortRef] = useState<{ current: AbortController | null }>({ current: null });
  const options = useMemo(() => modelOptions(modelConfig), [modelConfig]);

  // 若布局未加载成功，本页再兜底拉取一次
  useEffect(() => {
    if (modelConfigLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await window.viewPoint.getModelConfig();
        if (!cancelled && config?.platforms) dispatch(setModelConfig(config));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelConfigLoaded, dispatch]);

  const ensurePrepared = useCallback(async () => {
    if (!c.localVideoPath) throw new Error('请先选择视频');
    if (c.preparedId && c.inputPath) return c;
    setPreparing(true);
    try {
      const res = await window.viewPoint.prepareSourceEx({ filePath: c.localVideoPath });
      if (res.error || !res.preparedId) throw new Error(res.error || '视频准备失败');
      dispatch(
        setPreparedSource({
          preparedId: res.preparedId,
          inputPath: res.inputPath,
          sourceUrl: res.sourceUrl,
          durationSeconds: res.durationSeconds,
        }),
      );
      return {
        ...c,
        preparedId: res.preparedId,
        inputPath: res.inputPath,
        sourceUrl: res.sourceUrl,
      };
    } finally {
      setPreparing(false);
    }
  }, [c, dispatch]);

  const onPick = async () => {
    const res = await window.viewPoint.pickVideoFile();
    if (res.canceled || !res.filePath) return;
    dispatch(setLocalVideo({ localVideoPath: res.filePath }));
    const dur = await window.viewPoint.getMediaDurationSeconds(res.filePath).catch(() => ({ durationSeconds: 0 }));
    dispatch(setLocalVideo({ localVideoPath: res.filePath, durationSeconds: dur.durationSeconds }));
  };

  // 静默预处理
  useEffect(() => {
    if (!c.localVideoPath || c.preparedId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await window.viewPoint.prepareSourceEx({ filePath: c.localVideoPath });
        if (cancelled || res.error || !res.preparedId) return;
        dispatch(
          setPreparedSource({
            preparedId: res.preparedId,
            inputPath: res.inputPath,
            sourceUrl: res.sourceUrl,
            durationSeconds: res.durationSeconds,
          }),
        );
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [c.localVideoPath, c.preparedId, dispatch]);

  const runGenerate = async () => {
    if (!c.localVideoPath) {
      message.error('请先选择视频');
      return;
    }
    setGenLoading(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await ensurePrepared();
      await generateCommentaryScript({
        store,
        getState: store.getState,
        modelConfig,
        signal: ac.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('cancel')) message.error(msg);
    } finally {
      setGenLoading(false);
      abortRef.current = null;
    }
  };

  /** 一键生成：脚本 + 裁剪 + 配音 + 合并 + 拼接 */
  const runQuick = async () => {
    if (!c.localVideoPath) {
      message.error('请先选择视频');
      return;
    }
    setGenLoading(true);
    dispatch(setQuickGenerate({ running: true, progress: 5 }));
    try {
      await ensurePrepared();
      await generateCommentaryScript({
        store,
        getState: store.getState,
        modelConfig,
      });
      dispatch(setQuickGenerate({ running: true, progress: 25 }));
      const st = store.getState().commentary;
      const script = Array.isArray(st.script) ? st.script : [];
      if (!script.length) throw new Error('脚本为空');

      // init segments
      type Job = { partNumber: number; segmentIndex: number; startMs: number; endMs: number; kind: string; voiceover?: string | null };
      const jobs: Job[] = [];
      for (const part of script) {
        const pn = Number(part.part_number);
        getPartSegmentEntries(part).forEach((s, idx) => {
          const kind = normalizeSegmentComposeKind(s.type, s);
          const range = getSegmentTimeRange(s);
          jobs.push({ partNumber: pn, segmentIndex: idx, startMs: range.startMs, endMs: range.endMs, kind, voiceover: s.voiceover });
        });
      }

      // clip
      await runWithConcurrency(jobs, 4, async (job) => {
        const res = await window.viewPoint.clipSegmentEx({
          preparedId: st.preparedId,
          partNumber: job.partNumber,
          segmentIndex: job.segmentIndex,
          startMs: job.startMs,
          endMs: job.endMs,
          inputPath: st.inputPath,
        });
        dispatch({
          type: 'commentary/upsertSegment',
          payload: {
            key: segmentKey(job.partNumber, job.segmentIndex),
            value: {
              partNumber: job.partNumber,
              segmentIndex: job.segmentIndex,
              startMs: job.startMs,
              endMs: job.endMs,
              status: 'done',
              outputPath: res.outputPath,
              segmentUrl: res.segmentUrl,
            },
          },
        });
      });
      dispatch(setQuickGenerate({ running: true, progress: 45 }));

      // voice + merge
      const commentaryJobs = jobs.filter((j) => j.kind === 'commentary' && j.voiceover?.trim());
      await runWithConcurrency(commentaryJobs, 4, async (job) => {
        const voice = await window.viewPoint.generateVoice({
          preparedId: st.preparedId,
          partNumber: job.partNumber,
          segmentIndex: job.segmentIndex,
          text: job.voiceover || '',
          voiceId: st.voiceSettings.voiceId,
          speed: st.voiceSettings.speed,
        });
        const vk = voiceKey(job.partNumber, job.segmentIndex);
        dispatch({
          type: 'commentary/upsertVoice',
          payload: {
            key: vk,
            value: {
              partNumber: job.partNumber,
              segmentIndex: job.segmentIndex,
              text: job.voiceover || '',
              voiceId: st.voiceSettings.voiceId,
              speed: st.voiceSettings.speed,
              status: 'done',
              outputPath: voice.outputPath,
              audioUrl: voice.audioUrl,
              version: 1,
            },
          },
        });
        const segKey = segmentKey(job.partNumber, job.segmentIndex);
        const seg = store.getState().commentary.segments[segKey];
        const merged = await window.viewPoint.mergeSegmentWithVoice({
          preparedId: st.preparedId,
          partNumber: job.partNumber,
          segmentIndex: job.segmentIndex,
          segmentPath: seg?.outputPath || '',
          voicePath: voice.outputPath,
          inputPath: st.inputPath,
          startMs: job.startMs,
        });
        const burned = await window.viewPoint.burnSubtitles({
          preparedId: st.preparedId,
          partNumber: job.partNumber,
          segmentIndex: job.segmentIndex,
          mergedVideoPath: merged.outputPath,
          voiceAudioPath: voice.outputPath,
          text: job.voiceover || '',
          ...st.subtitleSettings,
        });
        dispatch({
          type: 'commentary/patchSegment',
          payload: {
            key: segKey,
            patch: {
              mergedOutputPath: burned.outputPath,
              mergedUrl: burned.url,
              mergedBaseOutputPath: merged.outputPath,
              mergedBaseUrl: merged.outputUrl,
              sourceStartMs: job.startMs,
              sourceEndMs: job.endMs,
            },
            invalidateDownstream: false,
          },
        });
      });
      dispatch(setQuickGenerate({ running: true, progress: 62 }));

      // compose part 1
      const part1 = script[0];
      const pn = Number(part1?.part_number || 1);
      const st2 = store.getState().commentary;
      const composeItems = getPartSegmentEntries(part1).map((s, idx) => {
        const kind = normalizeSegmentComposeKind(s.type, s);
        const seg = st2.segments[segmentKey(pn, idx)];
        if (kind === 'commentary') {
          return { videoPath: seg?.mergedOutputPath || '', type: 'commentary' as const };
        }
        return {
          videoPath: seg?.outputPath || '',
          type: 'original_clip' as const,
          removeBackgroundAudio: seg?.removeBackgroundAudio ?? false,
        };
      }).filter((x) => x.videoPath);

      if (!composeItems.length) throw new Error('没有可合成片段');
      const composed = await window.viewPoint.composePartVideoEx({
        preparedId: st2.preparedId,
        partNumber: pn,
        segments: composeItems,
        backgroundMusicPath: st2.composeAudioSettings.backgroundMusicPath || undefined,
        backgroundMusicVolume: st2.composeAudioSettings.backgroundMusicVolume,
        originalClipVolume: st2.composeAudioSettings.originalClipVolume,
        forcedAspectRatio: st2.composeAudioSettings.forcedAspectRatio,
        videoBitrateKbps: st2.composeAudioSettings.finalVideoBitrateKbps,
      });
      dispatch({
        type: 'commentary/setFinalPart',
        payload: { partNumber: pn, outputPath: composed.outputPath, finalUrl: composed.finalUrl },
      });
      dispatch(setQuickGenerate({ running: false, progress: 100 }));
      dispatch(setCurrentStep(5));
      message.success('一键生成完成');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
      dispatch(setQuickGenerate({ running: false }));
    } finally {
      setGenLoading(false);
    }
  };

  const scriptPreview = useMemo(() => {
    if (Array.isArray(c.script)) return JSON.stringify(c.script, null, 2);
    return typeof c.script === 'string' ? c.script : '';
  }, [c.script]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="上传影视剧原片"
        extra={
          <Space>
            <Button icon={<ThunderboltOutlined />} type="primary" loading={genLoading} onClick={runQuick}>
              一键生成成片
            </Button>
            <Button loading={genLoading} onClick={runGenerate}>
              仅生成脚本
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap>
            <Button icon={<UploadOutlined />} onClick={onPick} loading={preparing}>
              选择视频文件
            </Button>
            {c.localVideoPath ? (
              <Text type="secondary">
                {c.localVideoPath} · {Math.round(c.localVideoDurationSeconds || 0)}s
              </Text>
            ) : (
              <Text type="secondary">未选择视频</Text>
            )}
          </Space>
          {c.sourceUrl ? (
            <video
              src={c.sourceUrl}
              controls
              style={{ width: '100%', maxHeight: 280, background: '#000', borderRadius: 8 }}
            />
          ) : null}
          {c.quickGenerateRunning ? (
            <Progress percent={c.quickGenerateProgress} status="active" />
          ) : null}
          {c.isGeneratingScript ? (
            <Space>
              <Spin size="small" />
              <Text>{c.scriptGenerateProgress || '生成中…'}</Text>
            </Space>
          ) : null}
        </Space>
      </Card>

      <Card title="生成参数">
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap size={16}>
            <span>
              解说:原片{' '}
              <InputNumber
                size="small"
                min={1}
                max={10}
                value={c.commentaryRatioCommentary}
                onChange={(v) => dispatch(setCommentaryParams({ commentaryRatioCommentary: Number(v) || 1 }))}
              />
              :
              <InputNumber
                size="small"
                min={1}
                max={10}
                value={c.commentaryRatioOriginal}
                onChange={(v) => dispatch(setCommentaryParams({ commentaryRatioOriginal: Number(v) || 2 }))}
              />
            </span>
            <span>
              单条解说最长{' '}
              <InputNumber
                size="small"
                min={3}
                max={20}
                value={c.commentaryMaxSeconds}
                onChange={(v) => dispatch(setCommentaryParams({ commentaryMaxSeconds: Number(v) || 7 }))}
              />s
            </span>
            <span>
              上传压缩{' '}
              <Switch
                checked={c.compressForUploadEnabled}
                onChange={(v) => dispatch(setCompressSettings({ compressForUploadEnabled: v }))}
              />
            </span>
            {c.compressForUploadEnabled ? (
              <>
                <Select
                  size="small"
                  style={{ width: 100 }}
                  value={c.compressResolutionKey}
                  options={['1080p', '720p', '540p', '360p'].map((x) => ({ label: x, value: x }))}
                  onChange={(v) => dispatch(setCompressSettings({ compressResolutionKey: v as '360p' }))}
                />
                <span>
                  码率{' '}
                  <InputNumber
                    size="small"
                    min={100}
                    max={8000}
                    value={c.compressBitrateKbps}
                    onChange={(v) => dispatch(setCompressSettings({ compressBitrateKbps: Number(v) || 900 }))}
                  />
                  kbps
                </span>
              </>
            ) : null}
            <span>
              配音语速{' '}
              <Slider
                style={{ width: 120, display: 'inline-block', margin: '0 8px' }}
                min={0.5}
                max={2}
                step={0.1}
                value={c.voiceSettings.speed}
                onChange={(v) => dispatch(setVoiceSettings({ speed: v }))}
              />
            </span>
          </Space>

          <Alert
            type="info"
            showIcon
            message="解说专用模型（可在设置中先配置平台与模型）"
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                {(
                  [
                    ['step1SrtModel', 'SRT 模型'],
                    ['step1StructuredReportModel', '结构化报告'],
                    ['step1PlotBreakdownModel', '剧情拆解'],
                    ['step1MainScriptModel', '解说脚本'],
                    ['step1GoldenHookModel', '抓眼钩子'],
                    ['step7AdModel', '第七步广告'],
                  ] as const
                ).map(([key, label]) => (
                  <Space key={key} style={{ width: '100%' }}>
                    <Text style={{ width: 100 }}>{label}</Text>
                    <Select
                      allowClear
                      showSearch
                      style={{ minWidth: 280 }}
                      placeholder={
                        !modelConfigLoaded
                          ? '加载中…'
                          : options.length
                            ? '选择模型'
                            : '暂无模型，请先在设置中配置平台'
                      }
                      notFoundContent={
                        modelConfigLoaded && !options.length
                          ? '暂无模型，请先在设置 → 模型配置'
                          : undefined
                      }
                      options={options}
                      value={c.llmModels[key] || undefined}
                      onChange={(v) => dispatch(setLlmModel({ key, value: v || '' }))}
                    />
                  </Space>
                ))}
              </Space>
            }
          />
          <Input.TextArea
            rows={2}
            placeholder="内容范围约束（可选），例如：只截取主线感情戏"
            value={c.mediaContentScope}
            onChange={(e) => dispatch(setCommentaryParams({ mediaContentScope: e.target.value }))}
          />
        </Space>
      </Card>

      {scriptPreview ? (
        <Card title="脚本预览" extra={<Button size="small" onClick={() => dispatch(setScript(Array.isArray(c.script) ? c.script : []))}>刷新状态</Button>}>
          <Paragraph style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>
            {scriptPreview.slice(0, 20000)}
          </Paragraph>
        </Card>
      ) : null}
      {c.streamingScriptText ? (
        <Card title="流式生成中">
          <Paragraph style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {c.streamingScriptText.slice(-4000)}
          </Paragraph>
        </Card>
      ) : null}
    </Space>
  );
}
