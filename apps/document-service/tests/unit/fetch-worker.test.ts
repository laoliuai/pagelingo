import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { defaultCaptureLimits } from '@pagelingo/document-contracts';
import { capture } from '../helpers/web-capture.js';
import { validateCaptureInWorker } from '../../src/web-captures/worker-client.js';
it('terminates public article extraction at its parent deadline and on cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-fetch-worker-'));
  try {
    const value = capture('<article>' + '<p>A detailed paragraph about an original public article is available for reading.</p>'.repeat(15000) + '</article>');
    const path = join(directory, 'raw.html'); await writeFile(path, value.body);
    const input = { manifest: value.manifest, files: [{ id: 'html', path }], limits: defaultCaptureLimits, publicArticle: { finalUrl: value.manifest.source.url } };
    await expect(validateCaptureInWorker(input, new AbortController().signal, 10)).rejects.toMatchObject({ code: 'CAPTURE_VALIDATION_TIMEOUT' });
    const controller = new AbortController(); const pending = validateCaptureInWorker(input, controller.signal);
    const assertion = expect(pending).rejects.toThrow('Cancelled by job owner'); controller.abort(new Error('Cancelled by job owner')); await assertion;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A redirect may change the base, but must not silently change saved source identity.
it('resolves relative links and images against a cross-host redirect in the actual worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgl-redirect-worker-'));
  try {
    const paragraph = '<p>The original public article explains how the reading system stores documents for later use. The reader can review the source and the following examples.</p>';
    const value = capture('<article><h1>Redirected article</h1>' + paragraph.repeat(8) + '<p><a href="guide">Reference</a></p><img src="images/chart.png"></article>');
    value.manifest.source.url = 'https://original.example/start?part=2&utm_source=test#read';
    const path = join(directory, 'raw.html'); await writeFile(path, value.body);
    const result = await validateCaptureInWorker({ manifest: value.manifest, files: [{ id: 'html', path }], limits: defaultCaptureLimits, publicArticle: { finalUrl: 'https://final.example/posts/article/' } }, new AbortController().signal);
    expect(result.manifest.source.url).toBe('https://original.example/start?part=2#read');
    expect(result.manifest.resources).toEqual(expect.arrayContaining([expect.objectContaining({ url: 'https://final.example/posts/article/images/chart.png' })]));
    const html = new TextDecoder().decode(result.files.find(file => file.id === 'html')!.bytes);
    expect(html).toContain('href="https://final.example/posts/article/guide"');
    expect(html).not.toContain('https://original.example/images/');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
