# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Frame Sight is an AI-driven video analysis and auto-editing desktop application. Users describe editing needs in natural language, and an LLM-powered Agent autonomously completes video Q&A and editing tasks. Built with Electron (main process) and React (renderer process), licensed under MIT.

## Quick Reference

### Build & Development Commands

```bash
# Install dependencies (requires corepack enabled for Yarn 4)
yarn install

# Start development (frontend + Electron concurrently)
yarn dev

# Start frontend only (Vite dev server on port 5173)
yarn dev:frontend

# Build for production
yarn build

# Type checking (both workspaces)
yarn typecheck

# Run tests
yarn test
```

### Test File Locations

All 9 test files are in `apps/frontend/src/agent/`:
- `llm/caller.test.ts`, `llm/contextManager.test.ts`
- `orchestrator.test.ts`, `react/parser.test.ts`
- `result/protocol.test.ts`, `taskStateMachine.test.ts`
- `tools/dynamicScript.test.ts`, `tools/ffmpegFallback.test.ts`, `tools/registry.test.ts`, `tools/shared.test.ts`

## Architecture

### Two-Process Electron Structure

- **Main Process** (`apps/desktop/src/`): File system operations, FFmpeg execution, S3 uploads, config persistence, voice config, report caching, and dynamic script tool sandboxing. All IPC channels use the `vp:` prefix.
- **Renderer Process** (`apps/frontend/src/`): Contains the Agent engine and React UI. Communicates with main process via `window.viewPoint` (exposed through `contextBridge` in preload.ts).

### Agent Engine (Renderer Process)

The core AI agent follows a **ReAct (Reasoning + Acting) loop** architecture:

1. **Intent Classification** (`agent/intent/classifier.ts`): Two-phase classification—fast rule matching first, then LLM classification. Routes to QA or Tool branch.
2. **QA Branch** (`agent/qa/responder.ts`): Answers video content questions using structured reports and SRT subtitles.
3. **Tool Branch** (`agent/react/loop.ts`): TODO-driven multi-step LLM-to-tool execution loop. LLM plans tasks as explicit TodoItems, then executes one tool per iteration.
4. **Task State Machine** (`agent/taskStateMachine.ts`): Separated from conversation history to prevent instruction drift. Injected before each LLM call.
5. **Context Management** (`agent/llm/contextManager.ts`): Compression threshold derived from model's `contextWindow` setting. Token usage tracked via API usage metrics.
6. **Result Protocol** (`agent/result/protocol.ts`, `agent/result/builder.ts`): Results serialized as `agent_result` fenced blocks appended to conversation.

### Tool System (12 Tools)

Managed by `ToolRegistry` in `agent/tools/registry.ts` — a unified registry handling registration, lookup, unregistration, and runtime dynamic registration (`registerDynamicFromResult`), with `onChange` listeners so the ReAct loop refreshes the system-prompt tool table when tools change. Built-ins are assembled via `createToolRegistry(deps)` (`createAllTools` remains as an array-form compatibility wrapper):

- **5 Analysis Tools**: `get_video_info`, `transcribe_audio`, `detect_scene_changes`, `detect_silence`, `search_subtitles`
- **4 Editing Tools**: `clip_and_concat`, `remove_silence`, `burn_subtitles`, `export_segment`
- **1 Speech Tool**: TTS
- **1 Fallback**: `ffmpeg_execute` (raw FFmpeg for watermarks, color grading, speed changes)
- **1 Dynamic**: `create_dynamic_script_tool` (creates temporary JS tools in VM sandbox)

### State Management

Two Redux slices:
- **flowSlice**: Agent chat sessions, task state, output dirs, LLM settings, with localStorage persistence
- **modelConfigSlice**: Model platform configurations

### IPC Pattern

All Electron IPC uses `vp:*` channel names. The preload script exposes `window.viewPoint` API via `contextBridge`. Frontend `ipc.ts` provides fallback Proxy for environments without preload.

## Key Technologies

| Technology | Version | Role |
|-----------|---------|------|
| Electron | ^41.0.3 | Desktop shell |
| React | ^18.3.1 | UI framework |
| Redux Toolkit | ^2.2.7 | State management |
| Vite | ^5.4.1 | Frontend build tool |
| TypeScript | ^5.5.4 | Language (strict mode, ES2022 target) |
| Vitest | ^2.0.5 | Test runner |
| fluent-ffmpeg | ^2.1.3 | FFmpeg wrapper |
| Yarn 4 | 4.9.1 | Package manager |

## Project Structure

```
frame-sight/
├── apps/
│   ├── frontend/          # React renderer (Vite + React 18)
│   │   └── src/
│   │       ├── agent/     # Agent engine core (intent, react loop, tools, llm)
│   │       ├── modules/   # UI pages (AgentPage, SettingsPage, router)
│   │       ├── store/     # Redux (flowSlice, modelConfigSlice)
│   │       └── utils/     # Helpers (modelChatEndpoint, llmModels)
│   └── desktop/           # Electron main process
│       └── src/
│           ├── main.ts    # Electron entry
│           ├── preload.ts # contextBridge API
│           ├── ipc.ts     # IPC handlers
│           └── *.service.ts  # Domain services
├── openspec/              # Change management (proposal/design/specs/tasks)
└── scripts/               # Dev utilities (wait-for.mjs)
```

## Build Process

- **Frontend**: Vite builds to `apps/desktop/frontend-dist/`
- **Main Process**: Compiled with plain `tsc` (no bundler), outputting ESM to `dist/`
- **Preload Script**: Compiled separately and renamed to `.cjs`
- **Dev Server**: Vite runs on port 5173, Electron waits for it before starting

## Environment Requirements

- Node.js >= 20
- Yarn 4 via corepack (`corepack enable`)
- FFmpeg in system PATH or via `FFMPEG_PATH` env var
- Electron binary (use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` for China region)

## Important Notes

- **Language**: Code identifiers in English; comments and UI strings in Chinese
- **No Default Model**: App requires manual model configuration; no built-in default LLM
- **Dynamic Script Tools**: Agent can create temporary JavaScript tools at runtime, executed in VM sandbox on main process, isolated per run
- **OpenSpec Workflow**: Project uses openspec-based change management with proposal/design/specs/tasks artifacts
