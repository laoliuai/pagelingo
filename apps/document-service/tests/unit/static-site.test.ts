import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerStaticSite } from '../../src/static-site.js';
import type { RuntimeConfig } from '../../src/config.js';

it('serves a WASM-only evaluation policy and caches only built assets even under an assets parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-static-'));
  const webDir = join(directory, 'assets', 'web');
  const app = Fastify();
  try {
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await mkdir(join(webDir, 'assets', 'pdfjs'), { recursive: true });
    await writeFile(join(webDir, 'assets', 'pdfjs', 'decoder.wasm'), 'wasm');
    await writeFile(join(webDir, 'index.html'), '<html>shell</html>');
    await writeFile(join(webDir, 'assets', 'app-hash.js'), 'export {};');
    const config: RuntimeConfig = {
      mode: 'production',
      publicOrigin: 'https://example.com',
      host: '127.0.0.1',
      port: 4320,
      dataDir: directory,
      databaseUrl: 'postgresql://unused/test',
      webDir,
      keyring: { activeKeyId: 'test', keys: { test: new Uint8Array(32) } },
      maxPdfBytes: 1024, bundleLimits: { ...defaultBundleLimits, maxPdfBytes: 1024 },
    };
    await registerStaticSite(app, config);
    const shell = await app.inject('/index.html');
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['cache-control']).toBe('no-store');
    expect(shell.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    const decoder = await app.inject('/assets/pdfjs/decoder.wasm');
    expect(decoder.statusCode).toBe(200);
    expect(decoder.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject('/assets/app-hash.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // The same CSP reaches both the shell and the externally served PDF worker.
    for (const response of [shell, asset]) {
      const policy = String(response.headers['content-security-policy']);
      const script = policy.split(';').find((value) => value.trim().startsWith('script-src '))!;
      expect(script).toContain("'self'");
      expect(script).toContain("'wasm-unsafe-eval'");
      expect(script).not.toContain("'unsafe-eval'");
      expect(script).not.toContain("'unsafe-inline'");
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
