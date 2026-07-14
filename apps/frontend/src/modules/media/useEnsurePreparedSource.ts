import { useCallback, useState } from 'react';

export interface PreparedSource {
  preparedId: string;
  inputPath: string;
  durationSeconds: number | null;
}

export interface EnsurePreparedSourceResult {
  ensure: (filePath: string) => Promise<PreparedSource | null>;
  loading: boolean;
  error: string | null;
}

/**
 * 视频源准备 hook：将视频源转码为可预览 mp4（已确保 preparedId/inputPath/duration）。
 */
export function useEnsurePreparedSource(): EnsurePreparedSourceResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensure = useCallback(async (filePath: string): Promise<PreparedSource | null> => {
    if (!filePath) return null;
    setLoading(true);
    setError(null);
    try {
      const result = await window.viewPoint.prepareSource({ filePath });
      return {
        preparedId: result.preparedId,
        inputPath: result.inputPath,
        durationSeconds: result.durationSeconds,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { ensure, loading, error };
}
