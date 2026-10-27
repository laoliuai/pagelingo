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
