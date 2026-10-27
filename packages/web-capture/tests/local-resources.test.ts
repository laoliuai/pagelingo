import { expect, it } from 'vitest';
import { captureUrlSchema, pendingCaptureResourceSchema } from '@pagelingo/document-contracts';
import { sanitizeNodeSnapshot } from '../src/node.js';
import { captureContentFingerprint } from '../src/index.js';
import { snapshotInput } from './helpers.js';

it('keeps bounded data and same-document-origin blob image locators through sanitizer replay and fingerprinting', async () => {
  const data = 'data:image/png;base64,aGVsbG8=';
  const blob = 'blob:https://e.test/ca64f96f-205e-46f3-af4a-47e1a61e1310';
  const snapshot = sanitizeNodeSnapshot(snapshotInput(`<article><img src="${data}"><img src="${blob}"></article>`));
  expect(snapshot.resources.map(resource => resource.url)).toEqual([data, blob]);
  const replay = sanitizeNodeSnapshot({ html: snapshot.html, url: snapshot.sourceUrl, scope: snapshot.scope }, undefined, snapshot.resources);
  expect(replay).toEqual(snapshot);
  const resources = snapshot.resources.map(resource => ({ ...resource, status: 'missing' as const, reason: 'unavailable' as const }));
  expect(await captureContentFingerprint(snapshot, resources)).toMatch(/^[a-f0-9]{64}$/);
  expect(captureUrlSchema.safeParse(data).success).toBe(false);
  expect(captureUrlSchema.safeParse(blob).success).toBe(false);
});
it('rejects foreign-origin blobs, active data, malformed base64 and local CSS locators', () => {
  const snapshot = sanitizeNodeSnapshot(snapshotInput('<article><img src="blob:https://other.test/ca64f96f-205e-46f3-af4a-47e1a61e1310"><img src="data:image/svg+xml;base64,PHN2Zz4="></article>'));
  expect(snapshot.resources).toEqual([]);
  for (const url of ['data:image/png;base64,a=', 'data:image/png;base64,a===', 'blob:https://user@e.test/id', 'blob:null/id']) {
    expect(pendingCaptureResourceSchema.safeParse({ id: 'r', role: 'image', url }).success).toBe(false);
  }
  expect(pendingCaptureResourceSchema.safeParse({ id: 'r', role: 'css', url: 'data:image/png;base64,aGVsbG8=' }).success).toBe(false);
});
it('deduplicates available blob bytes across object URLs while retaining uncertainty for missing blobs', async () => {
  const { sha256 } = await import('../src/index.js');
  const first = sanitizeNodeSnapshot(snapshotInput('<p>Image<img src="blob:https://e.test/ca64f96f-205e-46f3-af4a-47e1a61e1310"></p>'));
  const second = sanitizeNodeSnapshot(snapshotInput('<p>Image<img src="blob:https://e.test/ca64f96f-205e-46f3-af4a-47e1a61e1311"></p>'));
  const bytes = new Uint8Array([1, 2, 3]);
  const file = { id: 'image', path: 'image.png', bytes: bytes.length, sha256: await sha256(bytes), mediaType: 'image/png', role: 'image' as const };
  const available = (snapshot: typeof first) => snapshot.resources.map(resource => ({ ...resource, status: 'available' as const, fileId: 'image' }));
  const missing = (snapshot: typeof first) => snapshot.resources.map(resource => ({ ...resource, status: 'missing' as const, reason: 'unavailable' as const }));
  const fingerprint = await captureContentFingerprint(first, available(first), [file]);
  expect(await captureContentFingerprint(second, available(second), [file])).toBe(fingerprint);
  expect(await captureContentFingerprint(second, available(second), [{ ...file, sha256: await sha256(new Uint8Array([4, 5, 6])) }])).not.toBe(fingerprint);
  expect(await captureContentFingerprint(first, missing(first))).not.toBe(await captureContentFingerprint(second, missing(second)));
});
