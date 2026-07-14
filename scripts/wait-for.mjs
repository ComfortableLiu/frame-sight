/**
 * 等待指定 URL 可访问后退出。用于 dev 模式下 desktop 等待 vite dev server 就绪。
 * 用法: node scripts/wait-for.mjs http://localhost:5173
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: wait-for.mjs <url>');
  process.exit(1);
}

const maxAttempts = 60;
const intervalMs = 500;

for (let i = 0; i < maxAttempts; i++) {
  try {
    const res = await fetch(url, { method: 'GET' });
    if (res.ok || res.status < 500) {
      console.log(`[wait-for] ${url} ready`);
      process.exit(0);
    }
  } catch {
    // not ready yet
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
console.error(`[wait-for] ${url} not ready after ${maxAttempts * intervalMs}ms`);
process.exit(1);
