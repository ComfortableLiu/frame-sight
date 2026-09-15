import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  Button,
  Space,
  Select,
  Slider,
  Input,
  message,
  Typography,
  Tag,
  Empty,
  Alert,
} from 'antd';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCommentary,
  selectAdVideos,
  setStep7Config,
  setStep7Output,
  setAdVideos,
} from '../../store/commentarySlice.js';
import { buildStep7AdPrompt } from './step1Prompts.js';
import { extractJsonFromLlmText, parseTimeToMs } from '../../types/script.js';
import { streamChatCompletion } from './commentaryUtils.js';
import { resolveModelChatEndpoint } from '../../utils/modelChatEndpoint.js';
import { selectModelConfig } from '../../store/modelConfigSlice.js';

const { Text } = Typography;

export function Step7Page(): JSX.Element {
  const dispatch = useDispatch();
  const c = useSelector(selectCommentary);
  const adVideos = useSelector(selectAdVideos);
  const modelConfig = useSelector(selectModelConfig);
  const [analyzing, setAnalyzing] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [composing, setComposing] = useState(false);
  const [duration, setDuration] = useState(0);

  const config = c.step7Configs['1'] || {
    insertionTimeSec: 0,
    direction: '',
    bridgeText: '',
    adText: '',
    ttsSpeed: 1,
    voiceId: '',
  };
  const input = c.step6Outputs['1'];
  const output = c.step7Outputs['1'];

  useEffect(() => {
    window.viewPoint.adVideosList().then((res) => {
      dispatch(setAdVideos(res.items || []));
    }).catch(() => undefined);
  }, [dispatch]);

  useEffect(() => {
    if (!input?.outputPath) return;
    window.viewPoint.getMediaDurationSeconds(input.outputPath).then((r) => {
      setDuration(r.durationSeconds || 0);
    }).catch(() => undefined);
  }, [input?.outputPath]);

  useEffect(() => {
    if (!adVideos.length) return;
    if (!config.direction || !adVideos.find((a) => a.id === config.direction)) {
      dispatch(setStep7Config({ partNumber: 1, patch: { direction: adVideos[0].id } }));
    }
  }, [adVideos, config.direction, dispatch]);

  const patch = (p: Partial<typeof config>) => dispatch(setStep7Config({ partNumber: 1, patch: p }));

  const adPathMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of adVideos) m.set(a.id, a.filePath);
    return m;
  }, [adVideos]);

  if (!adVideos.length) {
    return (
      <Card title="嵌入广告">
        <Empty description="暂无广告视频，请先在设置页面添加广告视频" />
      </Card>
    );
  }

  const analyze = async () => {
    if (!input?.outputPath) {
      message.error('请先完成第六步');
      return;
    }
    setAnalyzing(true);
    try {
      patch({
        bridgeText: '',
        adText: '',
        adVoicePath: undefined,
        adVoiceUrl: undefined,
        adVoiceDurationSec: undefined,
        llmTargetBusiness: undefined,
        llmTriggerSentence: undefined,
        llmRationale: undefined,
      });
      const up = await window.viewPoint.uploadCommentaryMedia(input.outputPath);
      if (!up.url) throw new Error(up.error || '成片上传失败');
      patch({ llmSourceVideoHttpUrl: up.url });

      const modelRef = c.llmModels.step7AdModel;
      const ep = resolveModelChatEndpoint(modelRef, modelConfig);
      if (!ep?.apiKey) throw new Error('未配置第七步广告模型');

      const prompt = buildStep7AdPrompt(adVideos.map((a) => ({ name: a.name, description: a.description })));
      const srtBlock = c.step1SrtText?.trim()
        ? `\n\nASR/字幕文稿（请结合时间戳定位插入点）：\n${c.step1SrtText.trim().slice(0, 12000)}`
        : '';
      const { text } = await streamChatCompletion({
        apiBase: ep.apiBase,
        apiKey: ep.apiKey,
        model: ep.modelName,
        maxTokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'video_url', video_url: { url: up.url } },
              { type: 'text', text: prompt + srtBlock },
            ],
          },
        ],
      });
      const parsed = JSON.parse(extractJsonFromLlmText(text));
      const clip = parsed?.clip_data || parsed?.clipData || {};
      const logic = parsed?.insertion_logic || parsed?.insertionLogic || {};
      let insertion = 0;
      const ts = clip.insertion_timestamp_ms ?? clip.insertionTimestampMs;
      if (typeof ts === 'number') insertion = ts >= 1000 ? ts / 1000 : ts;
      else if (typeof ts === 'string') {
        const mmss = ts.match(/^(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/);
        if (mmss) {
          insertion =
            parseInt(mmss[1], 10) * 60 +
            parseInt(mmss[2], 10) +
            (mmss[3] ? parseInt(mmss[3].padEnd(3, '0'), 10) / 1000 : 0);
        } else insertion = parseTimeToMs(ts) / 1000;
      }
      const cap = Math.max(0.1, duration - 0.05);
      insertion = Math.min(Math.max(0, insertion), cap);
      const targetName = String(logic.target_ad_video_id || logic.targetAdVideoId || '');
      const matched =
        adVideos.find((a) => a.name === targetName) ||
        adVideos.find((a) => a.name.toLowerCase() === targetName.toLowerCase()) ||
        adVideos.find((a) => a.name.includes(targetName) || targetName.includes(a.name)) ||
        adVideos[0];
      patch({
        insertionTimeSec: insertion,
        direction: matched.id,
        bridgeText: String(clip.ad_transition_script || clip.adTransitionScript || ''),
        adText: String(clip.ad_core_script || clip.adCoreScript || ''),
        llmTargetBusiness: targetName,
        llmTriggerSentence: String(logic.trigger_sentence || logic.triggerSentence || ''),
        llmRationale: String(logic.rationale || ''),
      });
      message.success('LLM 分析完成，已回填可编辑参数');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const synthesizeAdVoice = async () => {
    const bridge = config.bridgeText.trim();
    const ad = config.adText.trim();
    if (!bridge || !ad) throw new Error('请先补全过渡话术和核心广告词');
    setSynthesizing(true);
    try {
      const res = await window.viewPoint.generateVoice({
        preparedId: c.preparedId || 'step7',
        partNumber: 1,
        segmentIndex: 700001,
        text: `${bridge}\n${ad}`,
        voiceId: config.voiceId,
        speed: config.ttsSpeed,
      });
      const dur = await window.viewPoint.getMediaDurationSeconds(res.outputPath);
      patch({
        adVoicePath: res.outputPath,
        adVoiceUrl: res.audioUrl,
        adVoiceDurationSec: dur.durationSeconds || 0,
      });
      return res;
    } finally {
      setSynthesizing(false);
    }
  };

  const compose = async () => {
    if (!input?.outputPath) {
      message.error('请先完成第六步');
      return;
    }
    const adPath = adPathMap.get(config.direction);
    if (!adPath) {
      message.error('请选择广告视频');
      return;
    }
    setComposing(true);
    try {
      let adAudioPath = config.adVoicePath;
      if (!adAudioPath) {
        message.loading({ content: '未检测到广告语音，正在先合成…', key: 'vp-step7-tts' });
        await synthesizeAdVoice();
        const latest = (await import('../../store/index.js')).store.getState().commentary.step7Configs['1'];
        adAudioPath = latest?.adVoicePath;
        message.success({ content: '广告语音合成完成', key: 'vp-step7-tts' });
      }
      if (!adAudioPath) throw new Error('广告语音合成失败');
      const res = await window.viewPoint.composeAdVideo({
        inputPath: input.outputPath,
        adVideoPath: adPath,
        adAudioPath,
        insertionTimeSec: config.insertionTimeSec,
        videoBitrateKbps: c.composeAudioSettings.finalVideoBitrateKbps,
      });
      dispatch(setStep7Output({ partNumber: 1, outputPath: res.outputPath, finalUrl: res.finalUrl }));
      message.success('第七步合成完成');
    } catch (err) {
      message.destroy('vp-step7-tts');
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setComposing(false);
    }
  };

  return (
    <Card
      title="嵌入广告"
      extra={
        <Space>
          <Button loading={analyzing} disabled={!input?.outputPath} onClick={analyze}>
            调用 LLM 分析插入点
          </Button>
          <Button
            type="primary"
            loading={composing || synthesizing}
            disabled={!input?.outputPath || !config.bridgeText.trim() || !config.adText.trim()}
            onClick={compose}
          >
            合成第七步成品
          </Button>
          <Button
            disabled={!output?.outputPath}
            onClick={async () => {
              if (!output) return;
              const res = await window.viewPoint.exportPartVideo({
                outputPath: output.outputPath,
                defaultFileName: 'part_1_ad.mp4',
              });
              if (!res.canceled) message.success('已导出');
            }}
          >
            导出
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {input?.outputPath ? (
          <Alert type="success" showIcon message="已就绪（来自第六步）" />
        ) : (
          <Alert type="error" showIcon message="请先完成第六步合成" />
        )}

        <Space size={24} align="start" wrap>
          <div>
            {input?.finalUrl ? (
              <video
                src={input.finalUrl}
                controls
                style={{ width: 320, maxHeight: 568, background: '#000', borderRadius: 8 }}
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = config.insertionTimeSec;
                  e.currentTarget.pause();
                }}
              />
            ) : (
              <div style={{ width: 320, height: 200, background: '#111', borderRadius: 8 }} />
            )}
            <Slider
              min={0}
              max={Math.max(0.1, duration)}
              step={0.01}
              value={config.insertionTimeSec}
              onChange={(v) => patch({ insertionTimeSec: v })}
            />
            <Text type="secondary">插入时间点：{config.insertionTimeSec.toFixed(2)}s / {duration.toFixed(2)}s</Text>
          </div>

          <Space direction="vertical" style={{ minWidth: 360 }} size={12}>
            <Space>
              <Text>广告视频</Text>
              <Select
                style={{ width: 240 }}
                value={config.direction}
                options={adVideos.map((a) => ({ label: a.name, value: a.id }))}
                onChange={(v) => patch({ direction: v })}
              />
            </Space>
            <Input.TextArea
              rows={2}
              placeholder="过渡话术"
              value={config.bridgeText}
              onChange={(e) => patch({ bridgeText: e.target.value })}
            />
            <Input.TextArea
              rows={2}
              placeholder="核心广告词"
              value={config.adText}
              onChange={(e) => patch({ adText: e.target.value })}
            />
            <Space>
              <Text>朗读语速</Text>
              <Slider style={{ width: 140 }} min={0.5} max={2} step={0.1} value={config.ttsSpeed} onChange={(v) => patch({ ttsSpeed: v })} />
              <Button size="small" loading={synthesizing} onClick={() => synthesizeAdVoice().catch((e) => message.error(e.message))}>
                合成广告朗读音频
              </Button>
            </Space>
            {config.adVoiceDurationSec ? (
              <Text type="secondary">当前音频时长：{config.adVoiceDurationSec.toFixed(2)}s</Text>
            ) : null}
            {config.adVoiceUrl ? <audio controls src={config.adVoiceUrl} style={{ width: '100%' }} /> : null}
            {config.llmTargetBusiness || config.llmRationale ? (
              <Card size="small" title="LLM 分析摘要">
                <Space direction="vertical">
                  <Tag color="blue">素材：{config.llmTargetBusiness}</Tag>
                  <Text type="secondary">插入点前一句：{config.llmTriggerSentence}</Text>
                  <Text type="secondary">理由：{config.llmRationale}</Text>
                </Space>
              </Card>
            ) : null}
          </Space>
        </Space>

        {output?.finalUrl ? (
          <video src={output.finalUrl} controls style={{ width: '100%', maxHeight: 360, background: '#000' }} />
        ) : null}
      </Space>
    </Card>
  );
}
