import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { ReadingPosition } from '@pagelingo/document-contracts';
import { readerTestApp, headers } from '../helpers/readers.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const t = await readerTestApp(cleanup); const f = await t.ingest();
  const descriptor = (await t.app.inject({ url: `${f.base}/reader`, headers: headers(t.alice) })).json();
  const position: ReadingPosition = { readerVersionId: f.version, sourceVersionId: descriptor.source.sourceVersionId, parseId: descriptor.parseId, blockId: 'b_00000000000000000000000000000001', blockOffset: 0.4, pdfPageIndex: 3, view: 'split', contentMode: 'translation' };
  const save = (expectedRevision: number, p = position) => t.app.inject({ method: 'PUT', url: `${f.base}/progress`, headers: headers(t.alice), payload: { expectedRevision, position: p } });
  const read = () => t.app.inject({ url: `${f.base}/progress`, headers: headers(t.alice) });
  return { ...t, f, position, save, read };
}
it('uses document-wide CAS and retains per-version history without writes on opening/restoring', async () => {
  const t = await setup(); expect((await t.read()).json()).toBeNull();
  const concurrent = await Promise.all([t.save(0), t.save(0, { ...t.position, blockOffset: 0.6 })]);
  expect(concurrent.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const acknowledged = (await t.read()).json(); expect(acknowledged.revision).toBe(1);
  const second = await t.ingest({ status: 'completed' });
  const restored = (await t.app.inject({ url: `${t.f.base}/reader`, headers: headers(t.alice) })).json();
  expect(restored.progress).toMatchObject({ revision: 1, position: { readerVersionId: second.version, blockId: t.position.blockId, pdfPageIndex: 3 } }); expect(restored.restoreHint).toBeNull();
  expect((await t.read()).json()).toEqual(acknowledged);
  expect((await t.save(1, restored.progress.position)).statusCode).toBe(200);
  const latestAcknowledgement = (await t.read()).json();
  const before = (await t.db.pool.query('SELECT * FROM reading_positions ORDER BY reader_version_id')).rows;
  const stale = await t.save(1); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('PROGRESS_CONFLICT');
  expect((await t.read()).json()).toEqual(latestAcknowledgement);
  expect((await t.db.pool.query('SELECT * FROM reading_positions ORDER BY reader_version_id')).rows).toEqual(before);
  const historical = (await t.app.inject({ url: `${t.f.base}/reader?versionId=${t.f.version}`, headers: headers(t.alice) })).json();
  expect(historical.progress).toMatchObject({ revision: 2, position: acknowledged.position });
  expect(historical.progress.updatedAt).toBe((await t.read()).json().updatedAt);
  expect((await t.save(2, historical.progress.position)).statusCode).toBe(200);
  expect((await t.read()).json()).toMatchObject({ revision: 3, position: acknowledged.position });
});
it('validates complete identity, block existence, bounds and independent PDF/content scroll before mutating any row', async () => {
  const t = await setup();
  for (const patch of [{ sourceVersionId: randomUUID() }, { readerVersionId: randomUUID() }, { parseId: 'p_' + '0'.repeat(64) }, { blockId: 'b_' + 'f'.repeat(32) }, { pdfPageIndex: 4 }, { pdfPageIndex: -1 }, { blockOffset: 1.01 }, { blockOffset: -0.1 }]) {
    expect((await t.save(0, { ...t.position, ...patch })).statusCode).toBe(400);
    expect((await t.read()).json()).toBeNull();
    expect((await t.db.pool.query('SELECT * FROM reading_positions')).rows).toEqual([]);
  }
  expect((await t.save(0)).statusCode).toBe(200); // text on pages 0/1, PDF pane independently on page 3
  expect((await t.read()).json()).toMatchObject({ revision: 1, position: t.position });
});
it('restores across parse changes at the physical page and keeps old position records', async () => {
  const t = await setup();
  const oldPosition = { ...t.position, blockId: 'b_00000000000000000000000000000008' };
  expect((await t.save(0, oldPosition)).statusCode).toBe(200);
  const second = await t.ingest({ partialParse: true, edit(files) {
    const ir = JSON.parse(files.get('source-ir.json')!.toString());
    const removed = ir.nodes.filter((node: { blockId?: string }) => node.blockId === oldPosition.blockId).map((node: { id: string }) => node.id);
    ir.nodes = ir.nodes.filter((node: { id: string }) => !removed.includes(node.id));
    for (const node of ir.nodes) node.children = node.children.filter((id: string) => !removed.includes(id));
    ir.blocks = ir.blocks.filter((block: { id: string }) => block.id !== oldPosition.blockId);
    files.set('source-ir.json', Buffer.from(JSON.stringify(ir)));
  } });
  const d = (await t.app.inject({ url: `${t.f.base}/reader?versionId=${second.version}`, headers: headers(t.alice) })).json();
  expect(d.restoreHint).toBe('version-updated-source-page');
  expect(d.progress).toMatchObject({ revision: 1, position: { readerVersionId: second.version, parseId: second.manifest.parse.id, pdfPageIndex: 3, blockId: null, blockOffset: 0 } });
  expect((await t.read()).json()).toMatchObject({ revision: 1, position: oldPosition });
  expect((await t.db.pool.query('SELECT * FROM reading_positions')).rows).toHaveLength(1);
});
it('rejects revoked sessions on every subsequent read/write and never returns saved progress to another owner', async () => {
  const t = await setup(); await t.save(0);
  await t.db.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.alice.user.id]);
  for (const url of [`${t.f.base}/reader`, `${t.f.base}/progress`, `${t.f.base}/readers/${t.f.version}/bundle`, '/api/v1/bundle-imports/limits']) expect((await t.app.inject({ url, headers: headers(t.alice) })).statusCode).toBe(401);
  expect((await t.save(1)).statusCode).toBe(401);
});
