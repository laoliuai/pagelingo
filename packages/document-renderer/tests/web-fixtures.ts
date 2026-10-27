import type { WebReaderIR, WebTranslation } from '@pagelingo/document-contracts';
import { planUnits } from '@pagelingo/translation-core';
import { snapshot, fixture, id } from './fixtures.js';
import { toWebTranslationDocument } from '../src/index.js';
export { id };
export function webBook(count = 2): WebReaderIR {
  const hash = 'a'.repeat(64);
  const ir: WebReaderIR = {
    schemaVersion: 'web-reader-ir/1', metadata: { title: 'Archived article', language: { language: 'en', sourceLanguage: 'en', reason: 'english-heuristic' } },
    source: { kind: 'web', manifestSha256: hash, snapshotSha256: 'b'.repeat(64), bytes: 100 },
    parse: { id: `p_${hash}`, inputManifestSha256: hash, projectorVersion: 'test/1', configSha256: hash, coverage: 'full', status: 'complete' },
    roots: [], nodes: [], blocks: [], assets: [], warnings: [],
  };
  for (let i = 1; i <= count; i++) {
    const blockId = id('b', i), nodeId = id('n', i);
    ir.roots.push(nodeId); ir.nodes.push({ id: nodeId, kind: 'block', blockId, children: [] });
    ir.blocks.push({ id: blockId, type: 'text', sourceRefs: [{ nodeId: `snapshot-${i}`, quote: 'Repeated paragraph', prefix: '', suffix: '' }], value: { id: blockId, kind: 'paragraph', content: [{ type: 'text', text: 'Repeated paragraph' }] }, bindings: [], safeMath: [], language: ir.metadata.language });
  }
  return ir;
}
export function webSnapshot(ir: WebReaderIR, completed = false): WebTranslation {
  const base = snapshot(fixture());
  const t: WebTranslation = { ...base, schemaVersion: 'web-reader-translation/1', parseId: ir.parse.id, sourceSha256: ir.source.manifestSha256, selectionBlockIds: ir.blocks.filter(b => b.type === 'text').map(b => b.id) };
  const plan = planUnits(toWebTranslationDocument(ir, t.selectionBlockIds), t.targetLanguage, t.profile, t.budget, t);
  t.units = plan.units.map(u => ({ id: u.id, blockId: plan.inputs[u.blockIndex].id, part: u.part, status: completed ? 'covered-by-block' : 'pending' }));
  t.blocks = plan.inputs.map(input => completed ? { blockId: input.id, status: 'translated', rawText: input.protectedText } : { blockId: input.id, status: 'source-only', reason: 'pending' });
  t.status = plan.inputs.length ? completed ? 'completed' : 'pending' : 'not-required'; t.generationKind = completed ? 'mock' : 'none';
  return t;
}
