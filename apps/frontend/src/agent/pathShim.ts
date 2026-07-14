/**
 * 路径拼接工具（渲染进程无 node path 模块）。
 * 仅用于拼接产物目录绝对路径与文件名。
 */

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function join(base: string, ...segments: string[]): string {
  const parts = [normalize(base)];
  for (const seg of segments) {
    parts.push(seg.replace(/^\/+/, '').replace(/\/+$/, ''));
  }
  return parts.filter(Boolean).join('/');
}
