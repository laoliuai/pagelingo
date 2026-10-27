import { it, expect } from 'vitest';
import { toWebTranslationDocument, validateWebTranslation } from '../src/index.js';
import { webBook, webSnapshot } from './web-fixtures.js';
it('projects ordered Web text without PDF identities and keeps distinct repeated blocks', () => {
  const ir = webBook();
  const doc = toWebTranslationDocument(ir, ir.blocks.map(b => b.id), 'fr');
  expect(doc.sourceLanguage).toBe('fr'); expect(doc.blocks.map(b => b.id)).toEqual(ir.blocks.map(b => b.id));
  expect(JSON.stringify(doc)).not.toContain('pageIndex');
  expect(() => toWebTranslationDocument(ir, [...ir.blocks].reverse().map(b => b.id))).toThrow();
  expect(() => toWebTranslationDocument(ir, [ir.blocks[0].id, ir.blocks[0].id])).toThrow();
});
it('replays real SDK results and preserves partial source-only reasons', () => {
  const ir = webBook(), t = webSnapshot(ir, true);
  t.blocks[1] = { blockId: ir.blocks[1].id, status: 'source-only', reason: 'failed' };
  t.units[1] = { ...t.units[1], status: 'failed' }; t.status = 'partial';
  const valid = validateWebTranslation(ir, t);
  expect(valid.blocks.get(ir.blocks[0].id)?.content).toEqual([{ type: 'text', text: 'Repeated paragraph' }]);
  expect(valid.sourceOnlyReasons.get(ir.blocks[1].id)).toBe('failed');
});
it.each(['identity', 'parse', 'missing', 'unknown', 'status', 'version', 'unit'] as const)('rejects Web translation %s forgery', kind => {
  const ir = webBook(), t = webSnapshot(ir, true);
  if (kind === 'identity') t.sourceSha256 = 'c'.repeat(64);
  if (kind === 'parse') t.parseId = `p_${'c'.repeat(64)}`;
  if (kind === 'missing') t.blocks.pop();
  if (kind === 'unknown') t.selectionBlockIds[0] = `b_${'f'.repeat(32)}`;
  if (kind === 'status') t.status = 'not-required';
  if (kind === 'version') t.sdkVersion = 'unknown';
  if (kind === 'unit') t.units.pop();
  expect(() => validateWebTranslation(ir, t)).toThrow();
});
it('rejects dropped protected markers and preserves source binding identity', () => {
  const ir = webBook(1), b = ir.blocks[0]; if (b.type !== 'text') throw Error('fixture');
  b.value.content = [{ type: 'text', text: 'Before ' }, { type: 'protected', id: 'code', kind: 'code', source: '<source>' }];
  b.bindings = [{ kind: 'protected', id: 'code', object: { type: 'code', text: '<source>' } }];
  const t = webSnapshot(ir, true);
  expect(validateWebTranslation(ir, t).blocks.get(b.id)?.content).toEqual(b.value.content);
  const result = t.blocks[0]; if (result.status === 'translated') result.rawText = 'Before translated';
  expect(() => validateWebTranslation(ir, t)).toThrow(/markers/);
});
it.each(['und', 'mul', 'zxx', 'und-US', 'mul-Latn', 'zxx-US', 'x', 'fr_XX', 'javascript:fr'])('rejects invalid manual source language %s', language => {
  const ir = webBook(); expect(() => toWebTranslationDocument(ir, [ir.blocks[0].id], language)).toThrow();
});
it('does not fabricate completion for an unselected foreign paragraph', () => {
  const ir = webBook(2), t = webSnapshot(ir, true);
  t.selectionBlockIds.pop(); t.units.pop(); t.blocks[1] = { blockId: ir.blocks[1].id, status: 'source-only', reason: 'manual-choice' }; t.status = 'partial';
  expect(validateWebTranslation(ir, t).sourceOnlyReasons.get(ir.blocks[1].id)).toBe('manual-choice');
  t.status = 'completed'; expect(() => validateWebTranslation(ir, t)).toThrow();
});
it('replays an imported whole-block proof without model job/profile metadata', () => {
  const ir = webBook(1), model = webSnapshot(ir, true), source = ir.blocks[0];
  if (source.type !== 'text' || model.blocks[0].status !== 'translated') throw Error('fixture');
  const imported = { schemaVersion: 'web-imported-translation/1', id: model.id, generationKind: 'import',
    sourceSha256: ir.source.manifestSha256, parseId: ir.parse.id, readerIrSha256: model.readerIrSha256,
    sourceSnapshotSha256: ir.source.snapshotSha256, sourceContentFingerprint: 'a'.repeat(64),
    sdkVersion: model.sdkVersion, promptVersion: model.promptVersion, protectionVersion: model.protectionVersion,
    sourceLanguage: 'en', targetLanguage: 'zh', status: 'completed',
    blocks: [{ blockId: source.id, nodeId: source.sourceRefs[0].nodeId, sourceTextSha256: 'a'.repeat(64), source: source.value, rawText: model.blocks[0].rawText }],
  };
  expect(validateWebTranslation(ir, imported as never).blocks.get(source.id)?.content).toEqual(source.value.content);
  expect(() => validateWebTranslation(ir, { ...imported, blocks: [{ ...imported.blocks[0], source: { ...source.value, content: [{ type: 'text', text: 'Wrong source' }] } }] } as never)).toThrow();
});
