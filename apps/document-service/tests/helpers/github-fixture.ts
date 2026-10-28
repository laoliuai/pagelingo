import { createHash } from 'node:crypto';
import type { SourceTransport } from '../../src/source-adapters/types.js';
export const commit = 'a'.repeat(40);
export const raw = Buffer.from('# Fixed source\n\nThe repository documentation explains the software and the system.\n');
export const blob = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
export const html = '<article><h1>Fixed source</h1><p>The repository documentation explains the software and the system.</p><img src="https://images.example/figure.png" alt="Actual figure"><img src="https://images.example/hostile.svg" alt="Unavailable vector"><script>UNSAFE_SCRIPT()</script><form><input></form></article>';
export type Fixture = Record<string, { status?: number; type?: string; body: string; base64?: boolean }>;
export function githubFixture(overrides: Fixture = {}): Fixture {
  return {
    'https://api.github.com/repos/Org/Repo': { body: JSON.stringify({ id: 12345, owner: { login: 'Org' }, name: 'Repo', description: 'A public source', html_url: 'https://github.com/Org/Repo', default_branch: 'Main', private: false, extra: { ignored: true } }) },
    'https://api.github.com/repos/Org/Repo/commits/Main': { body: commit, type: 'application/vnd.github.sha' },
    [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github+json`]: { body: JSON.stringify({ type: 'file', path: 'docs/README.md', sha: blob, size: raw.length, encoding: 'base64', content: raw.toString('base64'), download_url: 'https://raw.githubusercontent.com/Org/Repo/Main/docs/README.md', ignored: true }) },
    [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.raw+json`]: { body: raw.toString(), type: 'text/plain' },
    [`https://api.github.com/repos/Org/Repo/readme?ref=${commit}|application/vnd.github.html+json`]: { body: html, type: 'text/html' },
    'https://images.example/figure.png': { body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', base64: true, type: 'image/png' },
    'https://images.example/hostile.svg': { body: '<svg onload="UNSAFE()"></svg>', type: 'image/svg+xml' }, ...overrides,
  };
}
export function fixtureTransport(fixtures: Fixture, seen: string[] = []): SourceTransport {
  async function response(url: string, accept: string) {
    seen.push(`${url}|${accept}`); const value = fixtures[`${url}|${accept}`] ?? fixtures[url];
    if (!value) throw new Error(`Unexpected fixture URL: ${url}|${accept}`);
    return new Response(value.base64 ? Buffer.from(value.body, 'base64') : value.body, { status: value.status ?? 200, headers: { 'content-type': value.type ?? 'application/json' } });
  }
  const download: SourceTransport['downloadResource'] = async (url, input, consume) => { const r = await response(url, input.accept); return consume((async function* () { yield new Uint8Array(await r.arrayBuffer()); })(), { status: r.status, url, headers: r.headers }); };
  return { readSmall: (url, input) => response(url, input.accept), downloadResource: download, downloadPdf: (url, input, consume) => download(url, { ...input, accept: 'application/pdf' }, consume) };
}
