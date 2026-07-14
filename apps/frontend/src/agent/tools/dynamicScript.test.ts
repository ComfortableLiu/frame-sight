import { describe, it, expect } from 'vitest';
import { validateDynamicManifest } from './dynamicScript.js';
import type { DynamicScriptManifest } from './dynamicTypes.js';

function manifest(name: string, source: string): DynamicScriptManifest {
  return { name, displayName: name, description: '', parameters: {}, source };
}

const VALID_SOURCE = `
async function main(input, ctx) {
  const out = JSON.stringify(input);
  ctx.files.writeText('result.txt', out);
  return { ok: true };
}
`;

describe('validateDynamicManifest (security scan, mirrors desktop AgentScriptToolService)', () => {
  it('accepts valid manifest', () => {
    const r = validateDynamicManifest(manifest('dynamic_foo', VALID_SOURCE));
    expect(r.valid).toBe(true);
    expect(r.blockedRules).toEqual([]);
  });

  it('rejects name without dynamic_ prefix', () => {
    const r = validateDynamicManifest(manifest('foo', VALID_SOURCE));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('dynamic_'))).toBe(true);
  });

  it('rejects name not snake_case', () => {
    const r = validateDynamicManifest(manifest('dynamic_Foo-Bar', VALID_SOURCE));
    expect(r.valid).toBe(false);
  });

  it('rejects missing main entry', () => {
    const r = validateDynamicManifest(manifest('dynamic_foo', 'const x = 1;'));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('main'))).toBe(true);
  });

  it('blocks dangerous identifier require', () => {
    const r = validateDynamicManifest(
      manifest('dynamic_foo', `async function main(input, ctx){ return require('fs'); }`),
    );
    expect(r.valid).toBe(false);
    expect(r.blockedRules).toContain('require');
  });

  it('blocks process', () => {
    const r = validateDynamicManifest(
      manifest('dynamic_foo', `async function main(input, ctx){ return process.env; }`),
    );
    expect(r.blockedRules).toContain('process');
  });

  it('blocks path escape ../', () => {
    const r = validateDynamicManifest(
      manifest('dynamic_foo', `async function main(input, ctx){ return '../../etc'; }`),
    );
    expect(r.valid).toBe(false);
    expect(r.blockedRules.some((b) => b.includes('路径逃逸'))).toBe(true);
  });

  it('blocks fetch', () => {
    const r = validateDynamicManifest(
      manifest('dynamic_foo', `async function main(input, ctx){ return fetch('http://x'); }`),
    );
    expect(r.blockedRules).toContain('fetch');
  });
});
