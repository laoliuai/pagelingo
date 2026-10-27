import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveHttpError } from '../../src/archive/client';
import { ArchiveDatabase } from '../../src/archive/database';
import { createArchiveOutbox } from '../../src/archive/outbox';
import type { SiteBinding } from '../../src/archive/binding';
import type { CaptureDraft, WebCaptureResult } from '@pagelingo/document-contracts';

const binding: SiteBinding = { siteOrigin: 'https://library.example', siteId: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', deviceId: '33333333-3333-4333-8333-333333333333', generation: '44444444-4444-4444-8444-444444444444' };
function draft(): CaptureDraft { return { captureId: crypto.randomUUID(), snapshot: { html: '<article data-pl-node-id="n1"><p data-pl-node-id="n2">中文原文内容。</p></article>', sourceUrl: 'https://source.example/story', scope: { kind: 'article', rootNodeId: 'n1', completeWithinScope: true, warnings: [] }, nodeIds: ['n1','n2'], resources: [], warnings: [] }, metadata: { title: '中文资料', author: null, publishedAt: null, capturedAt: '2026-10-28T00:00:00.000Z' }, canonicalUrl: null, kind: 'article', pendingResources: [], existingTranslation: null }; }
function fixture() {
  const db = new ArchiveDatabase(`archive-test-${crypto.randomUUID()}`);
  let current = binding; let request: any; let result: WebCaptureResult; let lost = true; let creates = 0; let commits = 0; const puts: string[] = [];
  const client = {
    async create(input: any, key: string) { creates++; expect(key).toBe(input.manifest.captureId); request ??= structuredClone(input); expect(input).toEqual(request); return result ??= { id: crypto.randomUUID(), captureId: key, status: 'created', receivedFileIds: [], missingFileIds: input.manifest.files.map((f: any) => f.id), documentId: null, sourceVersionId: null, readerVersionId: null, jobId: null, saveStatus: null, errorCode: null, warnings: [], createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' }; },
    async status() { return structuredClone(result); },
    async put(_id: string, file: { id: string }, bytes: Uint8Array) { expect(bytes.length).toBeGreaterThan(0); puts.push(file.id); result.missingFileIds = result.missingFileIds.filter(id => id !== file.id); result.receivedFileIds.push(file.id); },
    async commit() { commits++; result = { ...result, status: 'completed', documentId: crypto.randomUUID(), sourceVersionId: crypto.randomUUID(), readerVersionId: crypto.randomUUID(), saveStatus: 'original-saved' }; if (lost) { lost = false; throw new Error('lost ACK'); } return result; },
    async cancel() { return { ...result, status: 'cancelled' as const }; },
    async link(_input: unknown, _key: string) { return { documentId: crypto.randomUUID(), jobId: null }; },
  };
  const build = () => createArchiveOutbox({ database: db, current: async () => current, client: () => client, acquire: async () => { throw new Error('unexpected acquisition'); } });
  return { db, build, client, switch: (b: SiteBinding) => { current = b; }, counts: () => ({ creates, commits, puts }) };
}
describe('archive durable recovery', () => {
  it('persists source before acquisition and resumes lost commit ACK with the original ingestion and files', async () => {
    const f = fixture(); const input = draft(); const first = f.build(); await first.enqueueCapture(binding, input);
    expect((await f.db.get(binding, input.captureId))?.draft).toEqual(input);
    await first.drainOutbox(binding, new AbortController().signal);
    expect((await f.db.get(binding, input.captureId))?.state).toBe('retry');
    await f.build().resumeOutbox(binding);
    const saved = await f.db.get(binding, input.captureId);
    expect(saved?.state).toBe('completed'); expect(saved?.result?.saveStatus).toBe('original-saved');
    expect(f.counts().creates).toBe(1); expect(f.counts().commits).toBe(1); expect(new Set(f.counts().puts).size).toBe(f.counts().puts.length);
  });
  it('cannot inspect or deliver owner A queue after binding to B; same-owner reconnect resumes', async () => {
    const f = fixture(); const input = draft(); await f.build().enqueueCapture(binding, input);
    const b = { ...binding, ownerId: crypto.randomUUID(), generation: crypto.randomUUID() }; f.switch(b);
    expect(await f.db.list(b)).toEqual([]); expect(await f.db.get(b, input.captureId)).toBeUndefined();
    await f.build().resumeOutbox(b); expect(f.counts().creates).toBe(0);
    const reconnect = { ...binding, deviceId: crypto.randomUUID(), generation: crypto.randomUUID() }; f.switch(reconnect);
    await f.build().resumeOutbox(reconnect); await f.build().resumeOutbox(reconnect);
    expect((await f.db.get(reconnect, input.captureId))?.state).toBe('completed');
  });
});
it('retains explicit cancellation arriving during the create request', async () => {
  const f = fixture(); const input = draft(); const outbox = f.build();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const create = f.client.create; f.client.create = async (...args) => { const result = await create(...args); entered(); await waiting; return result; };
  await outbox.enqueueCapture(binding, input); const running = outbox.drainOutbox(binding, new AbortController().signal); await started;
  const cancelled = outbox.cancel(binding, input.captureId);
  await vi.waitFor(async () => expect((await f.db.get(binding, input.captureId))?.cancelRequested).toBe(true));
  release(); await running; await cancelled;
  expect((await f.db.get(binding, input.captureId))?.state).toBe('cancelled'); expect(f.counts().commits).toBe(0);
});
it('retries CAPTURE_REBASE_REQUIRED on the same ingestion without uploading again', async () => {
  const f = fixture(); const input = draft(); let rebases = 0; const commit = f.client.commit;
  f.client.commit = async () => { if (rebases++ < 2) throw new ArchiveHttpError(409, 'CAPTURE_REBASE_REQUIRED'); return commit(); };
  await f.build().enqueueCapture(binding, input); await f.build().resumeOutbox(binding); await f.build().resumeOutbox(binding);
  expect((await f.db.get(binding, input.captureId))?.state).toBe('completed'); expect(rebases).toBe(3); expect(f.counts().creates).toBe(1); expect(f.counts().puts).toEqual(['html']);
});
it('drops a late old-binding create response without adopting its ingestion or sending files', async () => {
  const f = fixture(); const input = draft(); const create = f.client.create;
  f.client.create = async (...args) => { const result = await create(...args); f.switch({ ...binding, ownerId: crypto.randomUUID(), generation: crypto.randomUUID() }); return result; };
  await f.build().enqueueCapture(binding, input); await f.build().drainOutbox(binding, new AbortController().signal);
  expect((await f.db.get(binding, input.captureId))?.ingestionId).toBeUndefined(); expect(f.counts().puts).toEqual([]);
});
it('persists each acquired file before the next acquisition and retransmits only server-missing files', async () => {
  const f = fixture(); const input = draft();
  input.pendingResources = [{ id: 'first', role: 'css', url: 'https://source.example/first.css' }, { id: 'second', role: 'css', url: 'https://source.example/second.css' }]; input.snapshot.resources = input.pendingResources;
  let acquisitions = 0; let failed = false;
  const put = f.client.put;
  f.client.put = async (...args) => { if (args[1].id === 'resource-1' && !failed) { failed = true; throw new Error('connection lost during file'); } return put(...args); };
  const make = () => createArchiveOutbox({ database: f.db, current: async () => binding, client: () => f.client, acquire: async (_draft, id) => {
    const persisted = await f.db.get(binding, input.captureId); expect(persisted?.draft).toEqual(input);
    if (id === 'second') expect((await f.db.files(binding, input.captureId)).map(file => file.descriptor.id)).toContain('resource-0');
    acquisitions++; return { bytes: new TextEncoder().encode('p { color: red }'), mediaType: 'text/css' };
  } });
  await make().enqueueCapture(binding, input); await make().resumeOutbox(binding); await make().resumeOutbox(binding); await make().resumeOutbox(binding);
  expect(acquisitions).toBe(2); expect(f.counts().puts).toEqual(['html', 'resource-0', 'resource-1']); expect((await f.db.get(binding, input.captureId))?.state).toBe('completed');
});
it('automatic retry stops after five failed attempts and explicit retry starts a new bounded budget', async () => {
  const f = fixture(); let now = 0; let calls = 0; const scheduled: number[] = [];
  f.client.create = async () => { calls++; throw new Error('offline'); };
  const outbox = createArchiveOutbox({ database: f.db, current: async () => binding, client: () => f.client, acquire: async () => { throw new Error(); }, now: () => now, schedule: async when => { scheduled.push(when); } });
  const input = draft(); await outbox.enqueueCapture(binding, input);
  for (let i = 0; i < 8; i++) { await outbox.drainOutbox(binding, new AbortController().signal); now += 300000; }
  expect(calls).toBe(5); expect((await f.db.get(binding, input.captureId))?.state).toBe('manual'); expect(scheduled[1]).toBe(2000);
  await outbox.resumeOutbox(binding); expect(calls).toBe(6); expect((await f.db.get(binding, input.captureId))?.attempts).toBe(1);
});
it('cancelling a link after a lost ACK reconciles the stable key instead of claiming the server rolled it back', async () => {
  const f = fixture(); const outbox = f.build(); let calls = 0; let key: string | undefined; const saved = { documentId: crypto.randomUUID(), jobId: null };
  f.client.link = async (_input: unknown, stableKey?: string) => { key ??= stableKey; expect(stableKey).toBe(key); if (calls++ === 0) throw new Error('link ACK lost'); return saved; };
  const id = await outbox.enqueueLink(binding, { url: 'https://source.example/link', title: 'Link only', translationIntent: 'none' }, ['正文不可用']);
  await outbox.drainOutbox(binding, new AbortController().signal); await outbox.cancel(binding, id);
  expect((await f.db.get(binding, id))?.state).toBe('completed'); expect((await f.db.get(binding, id))?.linkResult).toEqual(saved); expect(calls).toBe(2);
});
it('a manual retry queued behind an active upload starts after its failure without overwriting request state', async () => {
  const f = fixture(); const outbox = f.build(); const input = draft();
  let release!: () => void; let entered!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const create = f.client.create; f.client.create = async (...args) => { const result = await create(...args); entered(); await wait; return result; };
  await outbox.enqueueCapture(binding, input); const active = outbox.drainOutbox(binding, new AbortController().signal); await started;
  const retry = outbox.resumeOutbox(binding, input.captureId); await new Promise(resolve => setTimeout(resolve, 20)); release();
  await Promise.all([active, retry]); expect((await f.db.get(binding, input.captureId))?.state).toBe('completed'); expect(f.counts().creates).toBe(1);
});
it('confirms the published result when server completion wins a cancellation race', async () => {
  const f = fixture(); const input = draft(); const outbox = f.build();
  let release!: () => void; let entered!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const create = f.client.create; f.client.create = async (...args) => { const result = await create(...args); entered(); await held; return result; };
  const status = f.client.status;
  f.client.cancel = async () => {
    const before = await status(); const completed = { ...before, status: 'completed' as const, documentId: crypto.randomUUID(), sourceVersionId: crypto.randomUUID(), readerVersionId: crypto.randomUUID(), saveStatus: 'original-saved' as const, missingFileIds: [] };
    f.client.status = async () => completed;
    throw new ArchiveHttpError(409, 'CAPTURE_COMPLETED');
  };
  await outbox.enqueueCapture(binding, input); const active = outbox.drainOutbox(binding, new AbortController().signal); await started;
  const cancel = outbox.cancel(binding, input.captureId); await vi.waitFor(async () => expect((await f.db.get(binding, input.captureId))?.cancelRequested).toBe(true)); release(); await Promise.all([active, cancel]);
  expect((await f.db.get(binding, input.captureId))?.state).toBe('completed'); expect((await f.db.get(binding, input.captureId))?.result?.saveStatus).toBe('original-saved');
});
it('cancellation during acquisition stops remaining resources without creating a server ingestion', async () => {
  const f = fixture(); const input = draft();
  input.pendingResources = [{ id: 'first', role: 'css', url: 'https://source.example/first.css' }, { id: 'second', role: 'css', url: 'https://source.example/second.css' }]; input.snapshot.resources = input.pendingResources;
  let acquisitions = 0; let cancelled: Promise<void> | undefined;
  const outbox = createArchiveOutbox({ database: f.db, current: async () => binding, client: () => f.client, acquire: async () => {
    acquisitions++; cancelled = outbox.cancel(binding, input.captureId);
    await vi.waitFor(async () => expect((await f.db.get(binding, input.captureId))?.cancelRequested).toBe(true));
    return { bytes: new TextEncoder().encode('p { color: red }'), mediaType: 'text/css' };
  } });
  await outbox.enqueueCapture(binding, input); await outbox.drainOutbox(binding, new AbortController().signal); await cancelled;
  expect(acquisitions).toBe(1); expect(f.counts().creates).toBe(0); expect((await f.db.get(binding, input.captureId))?.state).toBe('cancelled');
});
it('durable cancellation during the first file PUT stops all later files on the same ingestion', async () => {
  const f = fixture(); const input = draft();
  input.pendingResources = [{ id: 'first', role: 'css', url: 'https://source.example/first.css' }, { id: 'second', role: 'css', url: 'https://source.example/second.css' }]; input.snapshot.resources = input.pendingResources;
  const outbox = createArchiveOutbox({ database: f.db, current: async () => binding, client: () => f.client, acquire: async () => ({ bytes: new TextEncoder().encode('p { color: red }'), mediaType: 'text/css' }) });
  const put = f.client.put; const cancel = f.client.cancel; const cancelledIngestions: string[] = [];
  f.client.put = async (...args) => { await put(...args); if (args[1].id === 'html') await f.db.requestCancel(binding, input.captureId); };
  f.client.cancel = async (id?: string) => { cancelledIngestions.push(id!); return cancel(); };
  await outbox.enqueueCapture(binding, input); await outbox.drainOutbox(binding, new AbortController().signal);
  const entry = await f.db.get(binding, input.captureId);
  expect(f.counts().puts).toEqual(['html']); expect(f.counts().commits).toBe(0);
  expect(cancelledIngestions).toEqual([entry!.ingestionId]); expect(entry?.state).toBe('cancelled');
});
it('a queued link cancelled while an earlier link is in flight is never submitted from the old drain snapshot', async () => {
  const f = fixture(); const outbox = f.build();
  await outbox.enqueueLink(binding, { url: 'https://source.example/one', translationIntent: 'none' }, []);
  await outbox.enqueueLink(binding, { url: 'https://source.example/two', translationIntent: 'none' }, []);
  const [first, second] = await f.db.list(binding); const sent: string[] = [];
  f.client.link = async (_input, key) => { sent.push(key); if (key === first!.id) await f.db.requestCancel(binding, second!.id); return { documentId: crypto.randomUUID(), jobId: null }; };
  await outbox.drainOutbox(binding, new AbortController().signal);
  expect(sent).toEqual([first!.id]); expect((await f.db.get(binding, second!.id))?.state).toBe('cancelled');
  expect((await f.db.get(binding, second!.id))?.linkAttempted).not.toBe(true);
});
it('cancellation at the awaited pre-send boundary suppresses a never-sent link despite its newly persisted attempt marker', async () => {
  const f = fixture(); const outbox = f.build();
  const id = await outbox.enqueueLink(binding, { url: 'https://source.example/pre-send', translationIntent: 'none' }, []);
  const put = f.db.put.bind(f.db); let intervened = false; let sent = 0;
  vi.spyOn(f.db, 'put').mockImplementation(async (b, entry) => {
    await put(b, entry);
    if (entry.id === id && entry.linkAttempted && !intervened) { intervened = true; await f.db.requestCancel(b, id); }
  });
  f.client.link = async () => { sent++; return { documentId: crypto.randomUUID(), jobId: null }; };
  await outbox.drainOutbox(binding, new AbortController().signal);
  expect(intervened).toBe(true); expect(sent).toBe(0); expect((await f.db.get(binding, id))?.state).toBe('cancelled');
  expect((await f.db.get(binding, id))?.linkAttempted).toBe(false);
});
