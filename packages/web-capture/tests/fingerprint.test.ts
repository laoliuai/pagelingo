import { expect, it } from 'vitest';
import { captureContentFingerprint, normalizeCaptureUrl } from '../src/index.js';
import { sanitizeNodeSnapshot } from '../src/node.js';
const snapshot = (text: string) => sanitizeNodeSnapshot({ html: `<p>${text}</p>`, url: 'https://e.test/a', scope: { kind: 'article', rootNodeId: 'root', completeWithinScope: true, warnings: [] } });
it('normalizes only known trackers while retaining identity query and fragments', () => {
  expect(normalizeCaptureUrl('https://e.test/a?id=7&utm_source=x#part')).toBe('https://e.test/a?id=7#part');
  expect(() => normalizeCaptureUrl('https://user:pass@e.test/')).toThrow();
  expect(() => normalizeCaptureUrl('data:text/html,x')).toThrow();
});
it('fingerprint_ignores_capture_time_not_content', async () => {
  const a = snapshot('hello');
  const b = Object.assign({}, a, { capturedAt: '2026-01-01', captureId: 'attempt-2' });
  expect(await captureContentFingerprint(a, [])).toMatch(/^[a-f0-9]{64}$/);
  expect(await captureContentFingerprint(a, [])).toBe(await captureContentFingerprint(b, []));
  expect(await captureContentFingerprint(a, [])).not.toBe(await captureContentFingerprint(snapshot('changed'), []));
  expect(await captureContentFingerprint(a, [{ id: 'r_1', role: 'image', url: 'https://e.test/x', status: 'missing', reason: 'unavailable' }])).not.toBe(await captureContentFingerprint(a, []));
});
