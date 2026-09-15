---
feature: commentary-mode
status: delivered
updated: 2026-09-15
branch: feat/commentary-mode
commits: be9b479..03c747c
---

# 影视剧解说模式（normal 七步工作流）

## Report

**What was built** — 在 Frame Sight 中落地与 Agent 模式共存的「影视剧解说」七步工作流：Agent 顶栏可进入解说模式，Step1 上传/压缩/S3 上传/多模态 SRT 与结构化报告（>600s 分段）/剧情拆解/抓眼钩子/分段脚本；Step2~5 裁剪、TTS 配音、合并烧字幕、拼接成片（BGM/水印/强制画幅）；Step6 封面与可拖拽文字；Step7 LLM 选点嵌入广告。主进程新增 local-media 协议、解说媒体服务与 IPC；状态落在 commentarySlice 并 localStorage 持久化。

**Verification** — `yarn typecheck` PASS；`yarn test` PASS（94 tests / 12 files）；`yarn build` PASS。

**Journey log** — 首版实现后独立 review 指出路径穿越、>600s 报告未分段、钩子零起点重试死代码、时间戳未归一、Step2/6/7 交互与契约缺口、成片取消无效、广告 A/V 错位等 critical，已在 03c747c 集中修复。上传侧适配为 S3（非 ViewPoint WOS）；Demucs 按 out-of-scope 仅保留 FFmpeg 路径。antd 5 仅包裹解说页 UI，Agent 页样式保持不变。

## [S1] Problem

Frame Sight 目前仅有 Agent 对话式剪辑模式。用户需要按固定七步工作流完成影视剧解说短视频：上传原片 → LLM 拉片生成结构化报告与脚本 → 逐条裁剪 → TTS 配音 → 合并音轨并烧字幕 → 拼接成片 → 封面文字 → 嵌入广告。目标是按 ViewPoint 解说模式技术文档在本仓库落地完整可跑通的 normal 模式，并与现有 Agent 模式共存。

## [S2] Design

### S2.1 模式与路由

- `flowMode: 'normal' | 'agent'`。首页/顶栏可切换；解说模式进入 Step1，Agent 模式进入现有 Agent 页。
- 路由沿用自研 Router，扩展为：
  - `agent`、`settings`
  - `commentary-step-1` … `commentary-step-7`
- `StepGuard`：按完成度计算 `maxAllowedStep`，越步访问重定向。
- `FlowLayout`：顶部步骤条 1~7 + 内容区。

### S2.2 数据模型

脚本结构（`types/script.ts`）按文档：

- `ScriptSegment`：`type | voiceover | value_type | voiceover_count | calculated_duration | video_timestamp | description`
- `ScriptPart`：`part_number | part_title | content_title | golden_hook | main_body | optional_ending`（兼容 `scripts`/`segments`）
- `getPartSegmentEntries`：golden_hook → main_body → optional_ending
- `normalizeSegmentComposeKind`：commentary / original_clip 别名归一
- `getSegmentTimeRange` / `parseTimeToMs`：四级时间兼容

key 约定：

- `segmentKey = ${partNumber}-${segmentIndex}`
- `voiceKey = ${partNumber}__${segmentIndex}`
- 目录 `part_XXX` / `seg_XXX`（3 位零填充）

### S2.3 Redux 状态（`commentarySlice`）

独立 slice，不污染 Agent 的 `flowSlice`。核心字段：

| 字段 | 说明 |
|------|------|
| localVideoPath / preparedId / inputPath / sourceUrl / durationSeconds | 源视频与 preparedSource |
| structuredReport / structuredReportSourceVideoLink / step1SrtText / script | Step1 产物 |
| segments / voices | 按 key 字典；持久化时 clipping/generating → idle |
| voiceSettings / subtitleSettings / composeAudioSettings | 配音/字幕/成片参数 |
| finalParts / step6Outputs / step7Configs / step7Outputs | 后续步骤产物 |
| adVideos | 广告素材列表（本地持久化） |
| currentStep / maxAllowedStep | 门禁 |
| llmModels: { step1Srt, step1Report, step1Plot, step1Script, step1Hook, step7Ad } | 解说专用模型引用 `platform::model` |

缓存：扩展 `localStorage` key `frame-sight:commentary-cache`，防抖 500ms 自动保存；启动时 `restoreCommentaryState` 并清洗中间态。

### S2.4 local-media 协议

主进程注册特权协议 `local-media:`：

- token = `sha1(prefix + ':' + absPath)`，前缀 `voice|clips|merged|final|subtitled|step6|step7|advideo|prepared`
- 注册表内存映射；重启后从已知 media 目录重建可选
- 前端 `<video src="local-media://token">` 预览

### S2.5 IPC 契约（新增/升级）

保留 Agent 既有方法；解说模式新增：

| 方法 | 行为 |
|------|------|
| `vp:pick-image-file` / `vp:pick-audio-file` | 封面图 / BGM 选择 |
| `vp:probe-source-preview` | 是否需转码 + 元数据 |
| `vp:prepare-source`（扩展） | 返回 `{preparedId, inputPath, sourceUrl, durationSeconds}`；缓存复用 |
| `vp:clip-segment`（解说版） | `{preparedId, partNumber, segmentIndex, startMs, endMs}` → 标准编码片段 + local-media URL |
| `vp:generate-voice` | 走设置页 TTS 配置；下载/保存 wav；可选 atempo；返回 `{outputPath, audioUrl}` |
| `vp:merge-segment-with-voice` | 按配音时长重裁 + 替换音轨 |
| `vp:burn-subtitles` | 按配音时长生成 SRT 并硬烧 |
| `vp:compose-part-video`（解说版） | concat + 可选 BGM/人声分离/水印/强制画幅/码率；进度 channel |
| `vp:compose-progress-status` / `vp:compose-progress-cancel` | 成片进度轮询与取消 |
| `vp:compose-cover-video` | Step6 封面 + drawtext 文字 |
| `vp:compose-ad-video` | Step7 定格贴片广告 |
| `vp:export-part-video` / `vp:export-all-videos` | 导出 |
| `vp:ad-videos-list/add/update/delete` | 广告素材 CRUD（userData json） |
| `vp:list-custom-fonts` | Step6 字体扫描（系统字体 + 可选目录） |
| `vp:extract-audio-to-wav` / `vp:compress-video-for-upload` | Step1 上传预处理 |
| `vp:upload-commentary-media` | 复用 S3 `StorageService.uploadFile`（替代 ViewPoint WOS） |

契约三文件同步：`preload.ts`、`ipc.ts`、`types/viewPoint.d.ts`。

### S2.6 媒体编码基线

所有中间产物：`libx264 veryfast crf23 yuv420p` + `aac 48k stereo` + `+faststart`，保证 concat `-c copy`。

- clip：`-ss` 前置 + scale 取偶
- merge：`-shortest` 以配音为准
- burn：subtitles filter + force_style（`FontSize*1.5`、ASS BGR 颜色、`Alignment=2`、`MarginV`）
- compose：三阶段（预处理/强制画幅/concat+BGM+水印+码率）
- Step6：画布 1080x1920（可关强制竖屏）+ cover overlay + drawtext
- Step7：插入点定格 clone 作背景 + 广告 overlay + 音轨拼接

人声分离：默认 FFmpeg `arnndn`（若模型文件不可用则跳过降噪并提示）；Demucs 后端探测为不可用（不下载运行时）。

### S2.7 Step1 编排

1. 报告复用三规则（缺失/换视频/复用）
2. 可选压缩 → S3 上传视频 URL；抽取 wav → S3 上传音频 URL
3. SRT：多模态 `input_audio` + 文档 §8 prompt → JSON 数组 → 转 SRT 文本
4. 结构化报告：多模态 `video_url` + 文档 §2 prompt（时长>600s 分段并行 2）→ 合并
5. 并行：剧情拆解（max_tokens 8000）+ 抓眼钩子（零起点重试 ≤5）
6. 分段脚本并行 5；每段时间戳越界重试 ≤10；截断续写 ≤48 轮
7. 钩子合入 + 时间戳归一 → 写 `script`

一键生成（可选入口）：Step1 完成后自动跑 Step2~5 流水（并发与文档一致），进度区间映射 0~100%。

### S2.8 Step2~7 页面

对齐文档 03 篇交互：

- Step2：全部裁剪（并发4）、微调 Modal（±200ms、当前帧设起止）
- Step3：仅 commentary；一键合成（并发5）；台词可编辑；预览变速试听
- Step4：merge+burn 串行；字幕样式拖拽 marginV；mergedBase 保留底版
- Step5：时间连续性对齐 ≤1s；composeItems；BGM/水印/强制比例 Modal；导出
- Step6：仅 part1；封面+WYSIWYG 文字拖拽；预设历史
- Step7：仅 part1；广告库；LLM 选点；TTS 段号 700001；composeAdVideo

### S2.9 TTS / 上传适配

- **TTS**：复用 `voice-config.service` 的 synthesis 配置（OpenAI 兼容 `/chat/completions` audio）。`generateVoice` 支持 `speed` 经 ffmpeg `atempo`。
- **上传**：复用 S3 `StorageService`，不再实现 ViewPoint 内网 WOS。
- **模型**：复用 `modelConfig.platforms`；解说场景模型选择写入 commentarySlice；未配置时引导设置页。

### S2.10 UI

- 引入 Ant Design 5（ConfigProvider + 中文 locale + 暗色算法匹配现有主题变量）
- 与现有自定义 CSS 变量共存：解说页容器使用 antd，Agent 页保持原样
- 中文文案

## [S3] Out of Scope

- Agent 模式行为变更（除 IPC 兼容保留）
- 短剧 shortDrama 模式
- Demucs 运行时下载与完整分离
- ViewPoint 内网 WOS 上传
- 移动端/打包分发优化
- 多语言 i18n

## Tasks

- [x] T1: 脚本类型与工具 — `types/script.ts` 解析/归一/时间工具 + 单测 — acceptance: parse/normalize/entries 测试通过 (covers: S2.2)
- [x] T2: commentarySlice 与缓存 — 状态、reducers、selectors、localStorage 恢复清洗 — acceptance: typecheck + 默认态/恢复逻辑正确 (covers: S2.3)
- [x] T3: local-media 协议 — 主进程协议注册与 token 映射 — acceptance: 注册后可返回文件流 (covers: S2.4)
- [x] T4: 媒体服务扩展 — clip/merge/burn/compose/cover/ad/export/progress — acceptance: 各方法参数校验与标准编码命令可执行 (covers: S2.6)
- [x] T5: IPC/preload/类型契约 — 解说模式全部 vp 通道 — acceptance: 三文件同步，typecheck 通过 (covers: S2.5)
- [x] T6: TTS 与上传适配 — generateVoice + S3 上传包装 — acceptance: 配置缺失时报错清晰；配置齐全时写 wav (covers: S2.9)
- [x] T7: 路由/StepGuard/FlowLayout/模式切换 — 七步导航与门禁 — acceptance: 越步重定向；可切 Agent (covers: S2.1)
- [x] T8: Step1 提示词与编排 — prompts + 报告/SRT/拆解/钩子/分段脚本 — acceptance: 有 mock 时写出 script；时间戳校验生效 (covers: S2.7)
- [x] T9: Step2~4 页面 — 裁剪/配音/合并字幕 — acceptance: 单条与批量可跑；产物写回 Redux (covers: S2.8)
- [x] T10: Step5~7 页面与设置广告库 — 成片/封面/广告 — acceptance: 有前置产物时可合成与导出 (covers: S2.8)
- [x] T11: 集成验证 — typecheck + test + 关键路径走查 — acceptance: `yarn typecheck`、`yarn test` 通过 (covers: S2)
