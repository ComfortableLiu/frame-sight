/** Step1 全部 LLM 提示词（按 ViewPoint 解说模式文档逐字）。 */

export const STRUCTURED_REPORT_MAX_TOKENS = 60000;
export const TARGET_TOTAL_SCRIPT_SECONDS = 180;
export const SEGMENT_PARALLEL_LIMIT = 5;
export const PLOT_BREAKDOWN_MAX_TOKENS = 8000;
export const SCRIPT_MAX_TOKENS_PER_ROUND = 60000;
export const SCRIPT_MAX_CONTINUATION_ROUNDS = 48;
export const MAX_GOLDEN_HOOK_ZERO_START_RETRY_COUNT = 5;
export const MAX_SEGMENT_TIMESTAMP_RETRY_COUNT = 10;

export function embedTextForPrompt(raw: string): string {
  return String(raw ?? '').replace(/\\/g, '\\\\').replace(/\r\n/g, '\n');
}

export function charsPerSecondFromVoiceSpeed(rate: number): number {
  const r = Math.min(2, Math.max(0.8, Number(rate)));
  if (!Number.isFinite(r)) return 9;
  if (r <= 0.9) return 7 + (r - 0.8) * 6;
  return 7.6 + (r - 0.9) * 14;
}

export function formatPromptDecimal(n: number, maxDecimals = 5): string {
  const s = n.toFixed(maxDecimals);
  return s.replace(/\.?0+$/, '') || '0';
}

export function formatTotalVideoDurationForPrompt(seconds?: number | null): string {
  if (!Number.isFinite(seconds as number)) return '未知';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function computeSegmentBudgetSeconds(totalSegments: number, segmentIndex: number): number {
  if (!Number.isFinite(totalSegments) || totalSegments <= 0) return TARGET_TOTAL_SCRIPT_SECONDS;
  const n = Math.floor(totalSegments);
  const idx = Math.floor(segmentIndex);
  if (idx < 1 || idx > n) {
    return Math.max(1, Math.round(TARGET_TOTAL_SCRIPT_SECONDS / n));
  }
  const base = Math.floor(TARGET_TOTAL_SCRIPT_SECONDS / n);
  const remainder = TARGET_TOTAL_SCRIPT_SECONDS - base * n;
  return base + (idx <= remainder ? 1 : 0);
}

export const STRUCTURED_REPORT_PROMPT_TEMPLATE = `# Role
你是专业影视拉片与场记助理，负责对视频做逐镜头/逐事件的客观记录。

# Task
对视频进行内容解析，将内部所有镜头转换、人物动作、环境变化等一切可见可听细节全部列举出来，形成一份文字版《结构化报告》。

# 原片总时长（硬性物理边界，与后续步骤 [TOTAL_VIDEO_DURATION] 一致）
- **TOTAL_VIDEO_DURATION**（原片可播放总时长）= **{{TOTAL_VIDEO_DURATION}}**。
- CSV 中「start_end_sec」列：每条记录的时间区间须落在 **0 秒 至 原片总秒数** 之内；区间结束不得晚于上述总时长；不得编造超出片长的镜头。
- 若上值为「未知」，则须以你从视频中判定的实际片尾为准确定总秒数，并仍遵守上述边界；全片须从起点连续覆盖至实际结束，勿遗漏片尾。

# 约定限制
- 画面描述必须精确到能直接按时间戳剪出对应镜头，禁止“随后/接着/过了一会儿”等模糊表述。
- 重要程度：10=核心剧情转折点；8-9=关键情节；6-7=次要情节；3-5=过渡镜头；1-2=空镜/无叙事信息。
- 只做客观事实记录：可见动作、可见物体、可听台词/旁白、字幕；禁止主观解读、推测、影评式评价。
- 严禁自作主张删减情节，必须完全符合尊重事实

# 输出格式（严格竖线分隔，必须含表头）
- 仅输出 **纯文本表格行**（UTF-8），不要 Markdown、不要代码块、不要解释。
- 字段分隔符必须使用 **竖线 \`|\`**（pipe）；严禁使用逗号作为字段分隔符。
- 第一行必须是表头（字段名固定，顺序固定）：
时间段|画面元素|情绪|重要程度
- 后续每行一条记录，对应字段含义：
  - 时间段：使用 **HH:MM:SS.mmm-HH:MM:SS.mmm**（例如 00:01:23.456-00:01:25.900），且须满足上一节「原片总时长」边界
  - 画面元素：画面核心元素（谁+在什么地方+做了什么），用中文描述
  - 情绪：场景情绪（客观：如紧张/平静，避免抽象形容词堆砌），用中文描述
  - 重要程度：重要程度（1-10）
- 若字段内容本身需要出现竖线，请改写措辞避免歧义（不要做额外转义协议）。

从视频开始连续覆盖到结束，不要遗漏关键切点。

# 输出要求
- 只输出报告正文，不要 Markdown 标题、不要代码块、不要前言后语。
- 全程描述必须是中文，严禁使用其他语言`;

export function buildStructuredReportPromptText(totalVideoDurationSeconds?: number | null): string {
  const bound = formatTotalVideoDurationForPrompt(totalVideoDurationSeconds);
  return STRUCTURED_REPORT_PROMPT_TEMPLATE.replace(/\{\{TOTAL_VIDEO_DURATION\}\}/g, bound);
}

export const GOLDEN_HOOK_FROM_REPORT_PROMPT_TEMPLATE = `# Role
你是一位短视频爆款拆解专家，擅长从镜头描述报告中提取冲突瞬间，重组为3-5秒内锁住注意力的“开场钩子”。

# Task
我会提供一份【镜头结构化报告】。请从中提取冲突最强的片段，输出一个JSON数组，构成“原片爆点 → 解说抛钩子 → 原片爆点 → 解说桥接”的4段结构。

# 硬约束（按优先级）
1. **冲突优先**：必须选争吵、质问、阴阳怪气、要钱、翻脸、反转类片段。禁止平淡过渡。
2. **无特效**：禁止添加任何字幕、花字、音效、特写、闪回、加速。
3. **结构固定**：输出必须为4个元素，顺序为：\`original_clip\` → \`commentary\` → \`original_clip\` → \`commentary\`。
4. **第一段原片**：前三秒内必须出现激烈台词（不需要解说先出现）。
5. **解说词长度**：
   - 第2段（抛钩子）：15-25字，时长约3-5秒（按每秒5字估算）
   - 第4段（转场桥接）：18-30字，时长约4-6秒
6. **转场桥接**：最后一条commentary的\`value_type\`必须为\`"转场桥接"\`，语义类似：“这到底是为什么？故事还要从头说起。”
7. **时间戳规则**：
   - 相邻元素首尾相接，时间不得重叠
   - original_clip时长≥2.5秒
   - commentary的\`calculated_duration\` = 解说词字符数 ÷ 5（向上取整一位小数）
   - video_timestamp字段为挑选出来的原视频片段的时间段
8. **禁止输出任何解释、分析、建议**，只输出JSON数组。
9. 组成结构：抓眼钩子 -> 抓眼钩子解说 -> 抓眼钩子 -> 转场桥接

# 输出格式
[
  {
    "type": "original_clip" | "commentary",
    "voiceover": "15-25字的解说词，抛出疑问或吐槽" | null,
    "value_type": "抓眼钩子 | 解说",
    "voiceover_count": x,
    "calculated_duration": xx.xx,
    "video_timestamp": {"start": "xx:xx:xx.xxx", "end": "xx:xx:xx.xxx"},
    "description": "xxxxx"
  }
]

# 《结构化报告》Input Start
{{STRUCTURED_REPORT}}`;

export function buildGoldenHookPromptText(structuredReport: string, voiceSpeed: number, srtText?: string): string {
  const reportBody = embedTextForPrompt(structuredReport.trim());
  const srtBody = embedTextForPrompt((srtText || '').trim());
  const withSrtReport = srtBody ? `${reportBody}\n\n[SRT补充上下文]\n${srtBody}` : reportBody;
  const vs = Number.isFinite(voiceSpeed) ? voiceSpeed : 1;
  return GOLDEN_HOOK_FROM_REPORT_PROMPT_TEMPLATE.replace('{{STRUCTURED_REPORT}}', withSrtReport)
    .replace(/\{\{VOICE_SPEED\}\}/g, formatPromptDecimal(vs, 4))
    .replace(/\{\{CHAR_PER_SEC\}\}/g, formatPromptDecimal(charsPerSecondFromVoiceSpeed(vs)));
}

export function buildPlotBreakdownPrompt(structuredReport: string, srtText?: string): string {
  const reportBody = embedTextForPrompt(structuredReport.trim());
  const srtBody = embedTextForPrompt((srtText || '').trim());
  const srtSection = srtBody
    ? `\n# SRT 补充上下文（必须结合使用，尤其是台词顺序与时间节点）\n${srtBody}\n`
    : '';
  return `# Role
你是影视叙事拆解编辑，负责在写解说词之前，先把全片拆成若干「关键剧情片段」。

# Task
阅读下方《结构化报告》，将全片拆分为 **3～8 个** 互不重叠、按时间顺序推进的剧情片段。每个片段对应报告中的一段连续时间区间（可概括到分钟级）。同时生成一个全片统一的 content_title（用于最终成片标题）。

# 约束
- 片段应覆盖从开场到结局/收尾的主要叙事弧，避免遗漏关键转折。
- 相邻片段在叙事上可衔接；禁止同一片段内跳跃无关剧情。
- 若总片长很短，可减少片段数（不少于 3 段）；若片长很长，不超过 8 段。
- content_title 必须是短句，**不超过 10 个字**，**不能有任何标点符号**，并且风格夸张、吸睛、有冲突感。

# 输出格式（仅输出 JSON，不要 Markdown 代码块、不要解释）
{
  "content_title": "全片统一标题（<=10字，无标点，夸张吸睛）",
  "plot_segments": [
    {
      "segment_index": 1,
      "title": "片段标题（短）",
      "summary": "该片段剧情梗概 2～5 句",
      "report_time_hint": "与报告对应的大致时间范围，如 00:00-05:30 或文字说明"
    }
  ]
}

# 《结构化报告》
${reportBody}
${srtSection}`;
}

export const SCRIPT_CONTINUATION_USER_TEXT = `【执行要求】请继续保持深度思考（deep thinking）。上文因长度限制被截断。请从上一段「最后一个字符」起接续输出，补全剩余 JSON：不要重复已出现的任何字符或片段，不要输出 Markdown 或说明文字，只输出接续部分，使「上文 + 本轮输出」拼接后为完整合法的 JSON 数组（最外层 [] 及所有括号闭合）。`;

export const SRT_TRANSCRIBE_PROMPT = `请仅根据输入音频输出 JSON 结构的逐段转写与声音要素分析结果。
硬性要求：
1) 仅输出纯文本，不要 Markdown、不要代码块、不要解释。
2) 必须输出合法 JSON（严格遵循 JSON 语法）：key 必须双引号，字符串值必须双引号。
3) 顶层必须是 JSON 数组，每个元素是一个对象，字段固定为：i,p,t,y,q,w,s。
4) 字段含义：
   - i: 段落索引（从1开始）
   - p: 说话角色（若无人说话写“无人说话”）
   - t: 台词（若无台词写”无台词”；必须原文逐字转写，严禁翻译/改写/润色/总结；台词必须保留原始语言（如英语、日语、韩语等），严禁翻译为中文或其他语言）
   - y: 音效描述（背景音乐、环境音、拟音等；若无写“无明显音效”）
   - q: 情绪标签（多个用英文逗号分隔；若无写“无明显情绪”）
   - w: 权重（1-10整数）
   - s: 时间范围，格式 HH:MM:SS.mmm-->HH:MM:SS.mmm
5) 时间必须单调递增。
6) 严禁输出标准 SRT（序号+时间戳+台词）。
7) 严格切分规则（必须执行）：
   - 单条 t 最长不超过 20 个汉字或 40 个字符，超出必须拆分为多条。
   - 说话人发生变化时必须新开一条对象，不允许多人台词合并到同一条。
   - 同一说话人连续发言，若中间有明显停顿（约 >= 0.2s）或语义转折，也必须拆分。
   - q 只能描述当前这一小条，不允许跨多人或跨长段总结。

输出示例：
[
  {
    "i": 2,
    "p": "小明，男-年轻",
    "t": "今天天气真好",
    "y": "轻松愉快的钢琴乐",
    "q": "开心,放松",
    "w": 3,
    "s": "01:34:57.345-->01:34:59.059"
  }
]

你是音频分析师，不是台词抄写师，所以严禁输出 SRT。`;

export function buildStep7AdPrompt(
  adVideos: Array<{ name: string; description?: string }>,
): string {
  const adVideoList = adVideos
    .map((v) => `- 「${v.name}」：${v.description || '无简介'}`)
    .join('\n');
  return `Role: 资深短视频广告剪辑与内容商业化专家

【执行要求】请开启深度思考（deep thinking）后再作答，先完成充分分析再输出最终结果。

Task
你将接收一段待处理的原视频，以及对应的**带有毫秒级时间戳的语音转文本（ASR）文稿**。你的任务是分析视频上下文，在视频的 [25% - 85%] 这一黄金中段区间内，寻找一个最自然的语句间歇，植入广告。

Input Data Format
1. 视频文件（用于感知画面和情绪）。
2. ASR 文本（包含毫秒时间戳），格式示例：
   [00:15,350 --> 00:19,200] 真是累死了，家里一团糟也没时间收拾。
   [00:19,500 --> 00:22,800] 连猫砂盆都几天没清理了。

可用广告素材
以下是可供选择的广告视频，请根据视频内容选择最匹配的一个：
${adVideoList}

广告内容策略
- 从上述广告素材中选择与视频内容最匹配的一项。
- 过渡语：必须结合插入点前一句话的语境。
- 核心词：简短有力突出广告视频所描述的服务优势。

核心约束（剪辑与安全原则）
1. **中段原则**：禁止在前 25% 或后 15% 的总时长内插入。
2. **绝对安全剪辑点**：广告必须插入在**两句话的毫秒级间歇之间**。
   - 禁止在人物说话的中间截断。
   - 最佳插入时间点：前一句话的**结束毫秒** + 50毫秒 (作为安全缓冲)。

Workflow
1. 计算视频合法区间。
2. 匹配广告素材：观察视频内容，从可用广告素材中选择最匹配的一项。
3. 锁定语句：在区间内检索 ASR 内容，找到能够丝滑过渡到该广告的最恰当语句。
4. 确认时间：锁定该语句的 \`结束毫秒\`，计算出最佳剪辑插入点。

Output Format (Strict JSON)
不要输出 Markdown 标记，严格输出 JSON 对象。
{
  "total_duration_ms": 0,
  "insertion_logic": {
    "target_ad_video_id": "所选择广告视频的「名称」（必须与上方的名称完全一致）",
    "trigger_sentence": "插入点前的一句话（来自ASR文稿）",
    "rationale": "选择该点和广告的理由（简述）"
  },
  "clip_data": {
    "insertion_timestamp_ms": "MM:SS,000",
    "ad_transition_script": "结合上下文的过渡话术",
    "ad_core_script": "核心广告词"
  }
}`;
}

export function scriptItemAndVideoTimestampSpec(totalVideoDurationBound: string): string {
  return `## ScriptItem 字段（\`main_body\` 与 golden_hook 每条数组元素结构一致）

### 必填字段
- **type**：\`"commentary"\` | \`"original_clip"\`
- **voiceover**：string（解说词）或 null（原声片段）
- **value_type**：string，本条语义标签（如「抓眼钩子」「转场桥接」等）
- **voiceover_count**：integer，\`voiceover\` 字符总数含标点
- **calculated_duration**：number，浮点数保留一位小数，本条时长（秒）
- **video_timestamp**：object，**必填**，定义见下节
- **description**：string，画面视觉与声效说明

### video_timestamp（object，每条 ScriptItem 必填）
- **语义**：在**原片**时间轴上的闭区间 [start, end]，须与《结构化报告》中对应镜头/事件的时间一致。
- **start**：string，区间起点（含）。格式 **HH:MM:SS.mmm**（必须带毫秒，如 00:00:12.340）。
- **end**：string，区间终点（含）。格式与 **start** 相同；将 start/end 解析为时间后须满足 **end ≥ start**。
- **type = commentary**：表示本条解说所**锚定、引用或叠画参考**的原片画面时间范围。
- **type = original_clip**：表示本条**实际裁切播放**的原片片段；区间长度应与 \`calculated_duration\`、画面内容大体一致。
- **边界**：${totalVideoDurationBound}`;
}

export function buildSegmentPartPrompt(params: {
  totalVideoDurationSeconds?: number | null;
  commentaryToOriginalRatio: { commentary: number; original: number };
  commentaryMaxSeconds: number;
  voiceSpeed: number;
  mediaContentScope?: string;
  structuredReport: string;
  srtText?: string;
  plotAnalysisJson: string;
  segment: { segment_index: number; title: string; summary: string; report_time_hint?: string };
  segmentIndex: number;
  totalSegments: number;
  segmentBudgetSeconds: number;
  isLastSegment: boolean;
  plotContentTitle?: string;
}): string {
  const {
    totalVideoDurationSeconds,
    commentaryToOriginalRatio,
    commentaryMaxSeconds,
    voiceSpeed,
    mediaContentScope,
    structuredReport,
    srtText,
    plotAnalysisJson,
    segment,
    segmentIndex,
    totalSegments,
    segmentBudgetSeconds,
    isLastSegment,
    plotContentTitle,
  } = params;

  const reportBody = embedTextForPrompt(structuredReport.trim());
  const srtBody = embedTextForPrompt((srtText || '').trim());
  const srtSection = srtBody
    ? `\n## SRT 补充上下文（强约束：台词与时间优先对齐该内容）\n${srtBody}\n`
    : '';
  const analysisBody = embedTextForPrompt(plotAnalysisJson.trim());
  const totalVideoDurationText = formatTotalVideoDurationForPrompt(totalVideoDurationSeconds);
  const scopeFinal = mediaContentScope?.trim() || '全片';
  const charPerSecStr = formatPromptDecimal(charsPerSecondFromVoiceSpeed(voiceSpeed), 4);
  const budget = segmentBudgetSeconds;
  const fixedContentTitle = plotContentTitle || '';

  return `# Role: 顶流短视频影视解说导演

## Task（仅写当前这一段 → 合并为一个 Part）
你正在为 **第 ${segmentIndex} / ${totalSegments} 段** 剧情撰写解说脚本正文。**本剧情只对应一个 Part**：输出数组长度必须为 1，且该 Part 内 \`main_body\` 覆盖本剧情全部内容，**不要**把本剧情拆成多个 Part。
- 当前片段标题：${segment.title}
- 当前片段梗概：${segment.summary}
- 与《结构化报告》对应提示：${segment.report_time_hint || '见报告时间轴'}
- **content_title 规则**：
  - 本步骤不创作标题，content_title 由前置「剧情拆解」步骤统一给出。
  - 当前固定值：${fixedContentTitle || '（未提供时留空字符串）'}。
- **时长（务必区分）**：
  - **[FULL_SCRIPT_TOTAL_BUDGET_SEC] = 180**：全片共 ${totalSegments} 段剧情，**所有段**的口播+原片截取 **合计** 目标约为此秒数（约 3 分钟）。这是**全片总预算**，不是单段预算。
  - **[SEGMENT_BUDGET_SEC] = ${budget}**：**仅本段（第 ${segmentIndex} 段）** 应控制的口播+原片 **合计** 目标约为此秒数（±15%）。全片各段的 [SEGMENT_BUDGET_SEC] 相加 ≈ [FULL_SCRIPT_TOTAL_BUDGET_SEC]。**禁止**把整片的 180 秒全部写进本段。

## 《结构化报告》（事实与时间轴来源）
${reportBody}
${srtSection}

## 剧情结构分析（前置步骤输出，须一致）
${analysisBody}

## Input Parameters
- [MEDIA_CONTENT_SCOPE] = "${scopeFinal}"
- [TOTAL_VIDEO_DURATION] = ${totalVideoDurationText}（原片物理总长，非本段口播预算）
- [FULL_SCRIPT_TOTAL_BUDGET_SEC] = 180（全片 ${totalSegments} 段解说合计目标）
- [SEGMENT_BUDGET_SEC] = ${budget}（**本段**口播+原片合计目标；勿与上一项混淆）
- [RATIO] = ${commentaryToOriginalRatio.commentary}:${commentaryToOriginalRatio.original} (解说与原片时长比例)
- [MAX_COMM_DURATION] = ${commentaryMaxSeconds}s
- [MAX_CLIP_DURATION] = 10s
- [CHAR_PER_SEC] = ${charPerSecStr}

## 解说词估时规则（必须执行）
1. 仅对 \`type = commentary\` 的条目计算口播估时：\`calculated_duration = voiceover_count / [CHAR_PER_SEC]\`。
2. \`voiceover_count\` 必须为该条 \`voiceover\` 的真实字符数（含中文标点与英文符号，不含空白补字）。
3. 每条 \`calculated_duration\` 保留 1 位小数（四舍五入）；同时保持与 \`voiceover_count\`、\`voiceover\` 文本长度一致。
4. 单条 commentary 的 \`calculated_duration\` 不得超过 [MAX_COMM_DURATION]。
5. 本段总时长校验：\`sum(main_body[].calculated_duration)\` 需接近 [SEGMENT_BUDGET_SEC]（允许 ±15%）。

## Core Logic
1. 只依据《结构化报告》中与当前片段相关的时间轴与画面，**不要**写其它剧情片段的内容。
2. \`main_body\` 内 commentary / original_clip 交替推进；时间戳在整片范围内单调推进，**禁止**与本段之前已写内容时间重叠。
3. 本 Part 内所有条目的 \`calculated_duration\` **之和**应接近 **[SEGMENT_BUDGET_SEC]**（${budget}s）。
4. ${isLastSegment ? '本段为最后一段：若需要可对全片作简短收束，`optional_ending` 可非 null；否则可 null。' : '本段不是最后一段：`optional_ending` 必须为 null。'}
5. original_clip长度最长不得超过15秒

${scriptItemAndVideoTimestampSpec(`所有 video_timestamp 的 start 与 end 须落在原片总时长 ${totalVideoDurationText}（[TOTAL_VIDEO_DURATION]）内，从 00:00 起算；与本段剧情对应的《结构化报告》时间轴一致，且在整片时间线上单调推进、勿与已写前段重叠。`)}

## Output Format (Strict JSON)
只输出 **一个** Part，外层为 **JSON 数组**（**数组长度必须为 1**）。
[
  {
    "part_number": ${segmentIndex},
    "part_title": "...",
    "content_title": "${fixedContentTitle}",
    "main_body": [
      {
        "type": "commentary",
        "voiceover": "...",
        "value_type": "...",
        "voiceover_count": 0,
        "calculated_duration": 0.0,
        "video_timestamp": { "start": "HH:MM:SS.mmm", "end": "HH:MM:SS.mmm" },
        "description": "..."
      }
    ],
    "optional_ending": null
  }
]

## Constraints
1. content_title 必须原样使用上方固定值；若固定值为空则输出空字符串，不要自行改写。
2. 纯净输出 JSON，不要 Markdown 代码块外文字。
3. 单段解说 \`calculated_duration\` 不超过 [MAX_COMM_DURATION]。
4. 单段原视频original_clip长度最长不得超过15秒。
5. \`part_number\` 必须等于 ${segmentIndex}。
6. 严禁流水账复述；解说要有信息增量。
7. 只允许使用原版的视频片段，严禁对视频加入任何包括但不限于加速、闪回、定格等特效。
8. 相邻片段时间区间 ** 严禁 ** 覆盖

## Action
开始输出 JSON。`.trim();
}

export function buildScriptPromptText(params: {
  totalVideoDurationSeconds?: number | null;
  commentaryToOriginalRatio: { commentary: number; original: number };
  commentaryMaxSeconds: number;
  voiceSpeed: number;
  mediaContentScope?: string;
  structuredReport: string;
  srtText?: string;
}): string {
  const reportBody = embedTextForPrompt(params.structuredReport.trim());
  const srtBody = embedTextForPrompt((params.srtText || '').trim());
  const srtSection = srtBody
    ? `\n## SRT 补充上下文（强烈优先用于台词与时间对齐）\n${srtBody}\n`
    : '';
  const totalVideoDurationText = formatTotalVideoDurationForPrompt(params.totalVideoDurationSeconds);
  const scopeFinal = params.mediaContentScope?.trim() || '全片';
  const charPerSecStr = formatPromptDecimal(charsPerSecondFromVoiceSpeed(params.voiceSpeed), 4);
  return `# Role: 顶流短视频影视解说导演

## Task:
仅依据下方《结构化报告》生成 **一段** 完整短视频解说脚本：只输出 **一个** Part（\`part_number\` 固定为 1），总口播+原片截取时长目标约 **180 秒（约 3 分钟）**。

## 《结构化报告》（唯一事实来源；时间轴与镜头以此为准）
${reportBody}
${srtSection}

## Input Parameters (核心控制变量 - 0或空字符串表示由AI自主决定):
- [MEDIA_CONTENT_SCOPE] = "${scopeFinal}"
- [TOTAL_VIDEO_DURATION] = ${totalVideoDurationText} (硬性物理边界：任何片段严禁超过此值)
- [RATIO] = ${params.commentaryToOriginalRatio.commentary}:${params.commentaryToOriginalRatio.original} (解说与原片时长比例)
- [TOTAL_BUDGET_SEC] ≈ 180 (本段成片总时长目标)
- [MAX_COMM_DURATION] = ${params.commentaryMaxSeconds}s (单条解说最长时限)
- [MAX_CLIP_DURATION] = 10s (原片单段硬限时)
- [CHAR_PER_SEC] = ${charPerSecStr}

## Core Logic:
1. 严格基于 \`[MEDIA_CONTENT_SCOPE]\` 与《结构化报告》筛选内容，**严禁越界**。
2. \`main_body\` 内 commentary / original_clip **AB 交替**；时间轴单调推进，禁止无逻辑回跳。
3. 控制 **该唯一 Part** 内所有 \`calculated_duration\` 之和接近 [TOTAL_BUDGET_SEC]（±15%）。

## Output Format (Strict JSON):
输出 **仅含一个元素的 JSON 数组**，即一个 Part；\`main_body\` 为 ScriptItem 数组（**不含** golden_hook）。

${scriptItemAndVideoTimestampSpec(`所有 video_timestamp 的 start 与 end 均须从 00:00 起算且不晚于原片总时长 ${totalVideoDurationText}（即 [TOTAL_VIDEO_DURATION]），并与《结构化报告》中对应时间一致。`)}

## Constraints:
1. 严禁 \`video_timestamp\` 超出 \`[TOTAL_VIDEO_DURATION]\`（${totalVideoDurationText}）所允许的原片时间范围。
2. 纯净输出 JSON，不要 Markdown 代码块外文字。
3. 单段解说 \`calculated_duration\` 不超过 [MAX_COMM_DURATION]。
4. 视频片段时间轴与《结构化报告》一致。

## Action:
请仅依据《结构化报告》生成 JSON。`.trim();
}
