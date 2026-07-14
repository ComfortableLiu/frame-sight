# Frame Sight

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AI 驱动的视频分析与自动剪辑桌面应用。用自然语言描述需求，Agent 自主完成视频问答与自动剪辑。

## 功能特性

- **自然语言驱动** — 输入"去掉静音段并导出 GIF"，Agent 自动识别意图、规划步骤、调用工具完成
- **视频问答** — 基于结构化拉片报告和 SRT 字幕，回答视频内容问题（引用时间戳）
- **自动剪辑** — 5 个分析工具 + 4 个编辑工具 + ffmpeg 兜底 + 动态脚本工具
- **TODO 驱动** — ReAct 循环以显式 TODO 列表驱动，UI 实时展示执行进度
- **S3 兼容上传** — 编辑产物自动上传至用户配置的 S3 兼容对象存储（AWS S3 / MinIO / 阿里云 OSS / 腾讯云 COS / Cloudflare R2）
- **模型自由配置** — 支持任意 OpenAI 兼容 API，无内置默认模型
- **深色/浅色主题** — 三模式切换：浅色、深色、跟随系统

## 技术架构

```
┌──────────────────────────────────────────────────────┐
│  AgentPage.tsx (React + Redux)                        │
│  视频选择 / 会话管理 / 聊天 UI / 工具进度 / TODO 面板   │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  agent/orchestrator.ts                                │
│  意图识别 → QA 分支 / ReAct 分支 → 结果构建            │
├───────────────────────────────────────────────────────┤
│  react/loop.ts          intent/classifier.ts          │
│  react/promptBuilder.ts qa/responder.ts               │
│  llm/caller.ts          llm/contextManager.ts         │
│  taskStateMachine.ts    result/protocol.ts            │
├───────────────────────────────────────────────────────┤
│  tools/registry.ts → analysis.ts / editing.ts         │
│                      ffmpegFallback.ts / dynamicScript│
└──────────────────┬───────────────────────────────────┘
                   │ IPC (vp:*)
┌──────────────────▼───────────────────────────────────┐
│  Electron 主进程                                       │
│  ipc.ts / video.service.ts / storage.service.ts       │
│  agent-script-tool.service.ts / model-config.service  │
└───────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户输入 → runAgent()
  → 上下文压缩（基于模型 contextWindow 派生阈值，API usage 实时计量）
  → 意图识别（规则快速匹配 + LLM 分类）
    ├─ QA 分支 → respondToQuestion → 返回结构化结果
    └─ 工具分支 → runReActLoop（TODO 驱动多轮 LLM ↔ 工具）
                  → buildToolResultPayload → 返回
  → 结果序列化为 agent_result 围栏 → 追加到会话
```

## 项目结构

```
frame-sight/
├── apps/
│   ├── frontend/                 # React 渲染进程
│   │   ├── src/
│   │   │   ├── agent/            # Agent 引擎核心
│   │   │   │   ├── llm/          # LLM 调用器、上下文管理
│   │   │   │   ├── intent/       # 意图识别
│   │   │   │   ├── react/        # ReAct 循环、提示词构建、响应解析
│   │   │   │   ├── qa/           # QA 响应器
│   │   │   │   ├── result/       # 结果协议与构建
│   │   │   │   ├── tools/        # 工具系统（分析/编辑/ffmpeg/动态脚本）
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── taskStateMachine.ts
│   │   │   │   ├── benchmark.ts      # LLM 吞吐测量
│   │   │   │   ├── startupBench.ts   # 启动测速
│   │   │   │   └── report.ts         # 结构化报告生成
│   │   │   ├── modules/
│   │   │   │   ├── pages/        # AgentPage、SettingsPage
│   │   │   │   ├── router/       # 轻量路由（history stack）
│   │   │   │   ├── media/        # 视频源准备 hook
│   │   │   │   └── settings/     # 设置 Modal（已迁移到 SettingsPage）
│   │   │   ├── store/            # Redux（flowSlice、modelConfigSlice）
│   │   │   ├── hooks/            # useTheme
│   │   │   ├── types/            # modelConfig、viewPoint 类型声明
│   │   │   ├── utils/            # modelChatEndpoint、llmModels
│   │   │   └── ipc.ts            # 渲染进程 IPC 安全代理
│   │   └── index.html
│   └── desktop/                  # Electron 主进程
│       └── src/
│           ├── main.ts
│           ├── preload.ts
│           ├── ipc.ts
│           ├── video.service.ts
│           ├── storage.service.ts
│           ├── model-config.service.ts
│           └── agent-script-tool.service.ts
├── scripts/
│   └── wait-for.mjs              # dev 启动等待脚本
├── openspec/                     # 变更管理（proposal/design/specs/tasks）
├── package.json                  # Yarn 4 workspace
├── .yarnrc.yml
└── vitest.config.ts
```

## 快速开始

### 环境要求

- Node.js ≥ 20
- Yarn 4（通过 corepack 启用）
- FFmpeg（系统 PATH 或设置 `FFMPEG_PATH` 环境变量）

### 安装

```bash
# 启用 corepack 并安装 Yarn 4
corepack enable

# 安装依赖
yarn install

# 手动安装 Electron 二进制（postinstall 可能静默失败）
# 设置国内镜像后重装，或从 https://npmmirror.com/mirrors/electron/ 手动下载
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ yarn install
```

### 开发

```bash
yarn dev
```

启动 Vite dev server（前端）+ Electron（桌面端），自动热更新。

首次启动时会运行一次后台测速（FFmpeg 硬件 + LLM 响应），结果缓存 24 小时用于报告预估。

### 构建

```bash
yarn build
```

### 测试

```bash
yarn test
```

### 类型检查

```bash
yarn typecheck
```

## 使用流程

1. **配置模型** — 点击右上角 ⚙ 设置 → 模型配置 → 添加平台（填写 API base + key）→ 同步模型 → 选择一个模型作为 Agent 模型
2. **（可选）配置对象存储** — 设置 → 对象存储 → 填写 S3 兼容配置 → 测试连接
3. **选择视频** — 点击"选择视频"，应用自动准备可预览格式
4. **输入需求** — 如"分析视频主要内容"、"去掉静音段并导出"、"截取 01:30 到 02:00 的片段转 GIF"
5. **查看结果** — Agent 执行完成后，可预览媒体、查看 TODO 进度面板

## 工具系统

### 分析工具

| 工具 | 功能 |
|------|------|
| `get_video_info` | 获取时长、分辨率、帧率、编码等 |
| `transcribe_audio` | 语音转文字生成 SRT |
| `detect_scene_changes` | ffmpeg scene 滤镜检测场景切换 |
| `detect_silence` | 静音段检测 |
| `search_subtitles` | 字幕关键词搜索 |

### 编辑工具

| 工具 | 功能 |
|------|------|
| `clip_and_concat` | 按时间段裁剪拼接 |
| `remove_silence` | 去除静音段 |
| `burn_subtitles` | 烧录字幕到画面 |
| `export_segment` | 导出片段（mp4/gif） |

### 其他工具

| 工具 | 功能 |
|------|------|
| `ffmpeg_execute` | FFmpeg 兜底（水印、调色、变速等） |
| `create_dynamic_script_tool` | 创建临时 JS 脚本工具（vm 沙箱） |

所有编辑工具自动上传产物至 S3 兼容存储，返回可访问 URL。

## 关键设计

- **TODO 驱动 ReAct** — 以显式 TodoItem 列表为循环一等状态，每轮 LLM 仅推进一个 TODO，终止条件清晰
- **任务状态机** — 与对话历史分离，每次 LLM 调用前注入当前任务指令，防止 instruction drift
- **两阶段意图识别** — 快速规则匹配（跳过 LLM）+ LLM 分类，解析失败默认 QA
- **上下文压缩** — 阈值由模型 contextWindow 派生，token 计量以 API usage 为主、本地估算兜底
- **启动测速** — 首次启动测 FFmpeg 硬件速度 + LLM 吞吐，缓存用于报告时间预估
- **产物隔离** — 每个会话独立产物目录，每个 run 唯一 ID，动态工具按 run 隔离

## 配置说明

### 模型配置

应用不内置默认模型，必须在设置中手动配置。支持任意 OpenAI 兼容 API（`/chat/completions`）。每个模型可设置 contextWindow（默认回退 200000），用于自动计算上下文压缩阈值。

### 对象存储配置

编辑工具产物自动上传。支持任意 S3 兼容服务，配置字段：

| 字段 | 说明 |
|------|------|
| Endpoint | S3 服务地址 |
| Region | 区域（默认 us-east-1） |
| Bucket | 存储桶名 |
| Access Key ID | 访问密钥 ID |
| Secret Access Key | 访问密钥 |
| Public URL Base | 公网访问前缀（留空则用预签名 URL） |
| Force Path Style | 路径样式（MinIO 等需勾选） |

## 开发指南

### 添加新工具

在 `apps/frontend/src/agent/tools/` 下创建工具实现，返回 `AgentTool`，在 `registry.ts` 的 `createAllTools` 中注册。

```typescript
const myTool: AgentTool = {
  name: 'my_tool',
  displayName: '我的工具',
  category: 'analysis',
  description: '给 LLM 理解的详细描述',
  parameters: { type: 'object', properties: { /* JSON Schema */ } },
  handler: async (args) => {
    // 实现
    return JSON.stringify({ success: true, result: '...' });
  },
};
```

### 添加新页面

在 `modules/router/Router.tsx` 的 `RouteName` 类型中添加路由名，在 `main.tsx` 的 `AppRouter` 中添加渲染逻辑，用 `useRouter().push()` 导航。

### IPC 扩展

1. 在 `preload.ts` 添加方法
2. 在 `ipc.ts`（desktop）注册 handler
3. 在 `types/viewPoint.d.ts` 补充类型声明

## License

[MIT](LICENSE) © 2026 逍遥成居士
