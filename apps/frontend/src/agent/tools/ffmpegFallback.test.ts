import { describe, it, expect } from 'vitest';
import { validateFfmpegCommand } from './ffmpegFallback.js';

const BASE = '/media/agent-outputs/abc';

describe('validateFfmpegCommand', () => {
  it('rejects -y flag', () => {
    const r = validateFfmpegCommand(['-i', 'in.mp4', '-y', `${BASE}/out.mp4`], BASE);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('-y');
  });

  it('rejects network input', () => {
    const r = validateFfmpegCommand(['-i', 'https://example.com/in.mp4', `${BASE}/out.mp4`], BASE);
    expect(r.valid).toBe(false);
  });

  it('rejects network output', () => {
    const r = validateFfmpegCommand(['-i', 'in.mp4', 'https://example.com/out.mp4'], BASE);
    expect(r.valid).toBe(false);
  });

  it('rejects output outside base dir', () => {
    const r = validateFfmpegCommand(['-i', 'in.mp4', '/etc/out.mp4'], BASE);
    expect(r.valid).toBe(false);
  });

  it('accepts valid command', () => {
    const r = validateFfmpegCommand(['-i', 'in.mp4', `${BASE}/out.mp4`], BASE);
    expect(r.valid).toBe(true);
  });

  it('rejects empty args', () => {
    const r = validateFfmpegCommand([], BASE);
    expect(r.valid).toBe(false);
  });
});
