import type { ModelConfig, ModelCapabilities } from '../../types/modelConfig.js';
import type { CommentaryLlmModels } from '../../store/commentarySlice.js';

export type CommentaryModelSlot = keyof CommentaryLlmModels;

export type ModelInputCapability = keyof ModelCapabilities;

export interface CommentaryModelSlotMeta {
  key: CommentaryModelSlot;
  label: string;
  /** 该步骤主要输入类型，用于筛选模型能力 */
  inputCapability: ModelInputCapability;
  /** 未单独指定时回退到设置页分析模型字段 */
  analysisFallback: 'speech' | 'video' | 'text' | null;
  hint: string;
}

export const COMMENTARY_MODEL_SLOTS: CommentaryModelSlotMeta[] = [
  {
    key: 'step1SrtModel',
    label: 'SRT 转写',
    inputCapability: 'audio',
    analysisFallback: 'speech',
    hint: '输入为抽取音频（wav）',
  },
  {
    key: 'step1StructuredReportModel',
    label: '结构化报告',
    inputCapability: 'video',
    analysisFallback: 'video',
    hint: '输入为视频 URL',
  },
  {
    key: 'step1PlotBreakdownModel',
    label: '剧情拆解',
    inputCapability: 'text',
    analysisFallback: 'text',
    hint: '输入为报告纯文本',
  },
  {
    key: 'step1MainScriptModel',
    label: '解说脚本',
    inputCapability: 'text',
    analysisFallback: 'text',
    hint: '输入为报告 + SRT 文本',
  },
  {
    key: 'step1GoldenHookModel',
    label: '抓眼钩子',
    inputCapability: 'text',
    analysisFallback: 'text',
    hint: '输入为报告文本',
  },
  {
    key: 'step7AdModel',
    label: '第七步广告',
    inputCapability: 'video',
    analysisFallback: 'video',
    hint: '输入为成片视频 + 字幕文本',
  },
];

/** 某平台模型的能力（未配置时视为未知，不过滤）。 */
export function getModelCapabilities(
  config: ModelConfig | undefined,
  platformName: string,
  modelName: string,
): ModelCapabilities | undefined {
  const p = config?.platforms?.find((x) => x.name === platformName);
  return p?.modelSettings?.[modelName]?.capabilities;
}

export interface ModelOption {
  label: string;
  value: string;
  capability?: ModelCapabilities;
  missingCapability?: boolean;
}

/** 只列出设置中勾选启用的模型，并按输入能力筛选。 */
export function buildCapabilityFilteredOptions(
  config: ModelConfig | undefined,
  inputCapability: ModelInputCapability,
): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of config?.platforms || []) {
    // 与设置 → 分析模型一致：仅 selectedModels
    const models = p.selectedModels || [];
    for (const m of models) {
      const caps = p.modelSettings?.[m]?.capabilities;
      // 未标注能力时：默认仅文本；音频/视频步骤不展示
      const effectiveCaps = caps ?? { audio: false, video: false, image: false, text: true };
      if (!effectiveCaps[inputCapability]) continue;
      const capTag =
        inputCapability === 'audio' ? '音频' : inputCapability === 'video' ? '视频' : '文本';
      out.push({
        label: `${p.name} · ${m}（${capTag}）`,
        value: `${p.name}::${m}`,
        capability: effectiveCaps,
        missingCapability: !caps,
      });
    }
  }
  return out;
}

/** 解说页槽位有效模型：优先解说覆盖，否则回退设置页分析模型。 */
export function resolveEffectiveCommentaryModel(
  slot: CommentaryModelSlot,
  commentaryModels: Partial<CommentaryLlmModels>,
  analysisModels: ModelConfig['analysisModels'],
): string {
  const override = commentaryModels?.[slot];
  if (override && override.trim()) return override.trim();
  const meta = COMMENTARY_MODEL_SLOTS.find((s) => s.key === slot);
  if (!meta?.analysisFallback) return '';
  return (analysisModels?.[meta.analysisFallback] || '').trim();
}

export function describeModelSource(
  slot: CommentaryModelSlot,
  commentaryModels: Partial<CommentaryLlmModels>,
  analysisModels: ModelConfig['analysisModels'],
): string {
  const override = commentaryModels?.[slot];
  if (override && override.trim()) return '解说页指定';
  const meta = COMMENTARY_MODEL_SLOTS.find((s) => s.key === slot);
  const fallback = meta?.analysisFallback ? analysisModels?.[meta.analysisFallback] : '';
  if (fallback) return `跟随设置 · ${meta?.analysisFallback}`;
  return '未配置';
}
