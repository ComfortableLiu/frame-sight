/**
 * window.viewPoint 安全代理。
 * preload 就绪前（如浏览器环境）注入一个 Proxy，所有方法返回与真实 API 同构的失败默认对象。
 */

const FALLBACK_MSG = '[ipc] window.viewPoint 未就绪';

/** 与真实 API 同构的失败默认返回值 */
const FALLBACK_DEFAULTS: Record<string, unknown> = {
  ffmpegExecute: { success: false, stdout: '', stderr: FALLBACK_MSG, exitCode: null },
  writeTempFile: { success: false, error: FALLBACK_MSG },
  ensureAgentOutputDir: { absPath: '', error: FALLBACK_MSG },
  deleteAgentOutputDir: { success: false, error: FALLBACK_MSG },
  openInFinder: { success: false, error: FALLBACK_MSG },
  fsAccess: { exists: false, readable: false },
  clearAgentOutputs: { success: false },
  uploadToObjectStorage: { objectUrl: '', error: FALLBACK_MSG },
  getStorageConfig: { config: undefined },
  saveStorageConfig: { success: false, error: FALLBACK_MSG },
  testStorageConnection: { success: false, message: FALLBACK_MSG },
  getConfig: {},
  pickVideoFile: { canceled: true },
  prepareSource: { preparedId: '', inputPath: '', durationSeconds: null, error: FALLBACK_MSG },
  clipSegment: { success: false, error: FALLBACK_MSG },
  composePartVideo: { success: false, error: FALLBACK_MSG },
  getMediaDuration: null,
  probeVideoQuality: { durationSeconds: null, width: null, height: null, frameRate: null, codec: null, container: null, fileSizeBytes: null },
  statFile: { size: null, exists: false },
  extractAudioFromVideo: { success: false, error: FALLBACK_MSG },
  getModelConfig: { platforms: [] },
  saveModelConfig: { success: false, error: FALLBACK_MSG },
  agentScriptToolValidate: { valid: false, errors: [FALLBACK_MSG], blockedRules: [] },
  agentScriptToolRegister: { success: false, error: FALLBACK_MSG },
  agentScriptToolExecute: { success: false, output: '', error: FALLBACK_MSG },
  agentScriptToolCleanup: { success: false },
};

function createFallbackProxy(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return undefined;
        return (..._args: unknown[]) => {
          console.warn(`${FALLBACK_MSG}: ${String(prop)}`);
          const def = FALLBACK_DEFAULTS[prop as string];
          return Promise.resolve(def ?? null);
        };
      },
    },
  );
}

/**
 * 确保 window.viewPoint 存在。
 */
export function ensureViewPoint(): void {
  const w = window as unknown as Record<string, unknown>;
  if (!w.viewPoint) {
    w.viewPoint = createFallbackProxy();
  }
}
