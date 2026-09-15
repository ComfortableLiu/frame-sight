import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';

export type LocalMediaPrefix =
  | 'voice'
  | 'clips'
  | 'merged'
  | 'final'
  | 'subtitled'
  | 'step6'
  | 'step7'
  | 'advideo'
  | 'prepared'
  | 'bgm'
  | 'image'
  | 'cover';

const tokenToPath = new Map<string, string>();

export function localMediaToken(prefix: LocalMediaPrefix | string, absPath: string): string {
  return createHash('sha1').update(`${prefix}:${absPath}`).digest('hex');
}

export function registerLocalMedia(prefix: LocalMediaPrefix | string, absPath: string): string {
  const token = localMediaToken(prefix, absPath);
  tokenToPath.set(token, path.resolve(absPath));
  return token;
}

export function localMediaUrl(prefix: LocalMediaPrefix | string, absPath: string): string {
  return `local-media://${registerLocalMedia(prefix, absPath)}`;
}

export function resolveLocalMediaToken(token: string): string | undefined {
  return tokenToPath.get(token);
}

export function listLocalMediaEntries(): Array<{ token: string; absPath: string }> {
  return Array.from(tokenToPath.entries()).map(([token, absPath]) => ({ token, absPath }));
}

/** 应用启动时调用，注册 local-media: 特权协议。 */
export function registerLocalMediaProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'local-media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function handleLocalMediaProtocol(): void {
  protocol.handle('local-media', (request) => {
    try {
      const url = new URL(request.url);
      // local-media://<token> 或 local-media://<token>/x
      const token = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
      const absPath = tokenToPath.get(token);
      if (!absPath || !fs.existsSync(absPath)) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(absPath).toString());
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}
