import { expect, it } from 'vitest';
import { encodeBlock, PROMPT_VERSION, PROTECTION_VERSION } from '@pagelingo/translation-core';
import type { WebImportedTranslation, WebReaderIR } from '@pagelingo/document-contracts';
import * as renderer from '../src/index.js';
import { webBook, webTable } from './web-fixtures.js';
function fixture(outside: boolean) {
  const ir = webTable(2, 1);
  if (outside) {
    const other = webBook(1); const block = other.blocks[0];
    block.id = `b_${'f'.repeat(32)}`; if (block.type === 'text') block.value.id = block.id;
    const node = other.nodes[0]; node.id = `n_${'f'.repeat(32)}`; if (node.kind === 'block') node.blockId = block.id;
    ir.blocks.push(block); ir.nodes.push(node); ir.roots.push(node.id);
  }
  const translation: WebImportedTranslation = {
    schemaVersion: 'web-imported-translation/1', id: '00000000-0000-4000-8000-000000000001', generationKind: 'import',
    sourceSha256: ir.source.manifestSha256, parseId: ir.parse.id, readerIrSha256: 'a'.repeat(64),
    sourceSnapshotSha256: ir.source.snapshotSha256, sourceContentFingerprint: 'b'.repeat(64),
    sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION,
    sourceLanguage: 'en', targetLanguage: 'zh', status: 'completed',
    blocks: ir.blocks.map((block, index) => {
      if (block.type !== 'text') throw Error('fixture');
      return { blockId: block.id, nodeId: block.sourceRefs[0].nodeId, sourceTextSha256: 'c'.repeat(64), source: block.value, rawText: index === 0 ? '译'.repeat(100000) : encodeBlock(block.value).protectedText };
    }),
  };
  return { ir, translation };
}
it('prunes failing repeated-context proofs in one diagnostic pass and retains an unrelated imported paragraph', () => {
  const { ir, translation } = fixture(true);
  expect(() => renderer.buildWebReader(ir, null)).not.toThrow();
  expect(() => renderer.buildWebReader(ir, translation)).toThrow(/context.*byte budget/);
  expect(renderer.buildWebImportedReader).toBeTypeOf('function');
  const result = renderer.buildWebImportedReader(ir, translation);
  expect(new Set(result.rejectedBlockIds)).toEqual(new Set(ir.blocks.slice(0, 2).map(b => b.id)));
  expect(result.translation?.blocks.map(b => b.blockId)).toEqual([ir.blocks[2].id]);
  expect(result.translation).toMatchObject({ status: 'partial', readerIrSha256: translation.readerIrSha256, sourceSha256: translation.sourceSha256 });
  expect(result.build.index).toMatchObject({ generationKind: 'import', translationStatus: 'partial' });
  expect(result.build.chunks.flatMap(c => c.blocks.filter(b => b.translation).map(b => b.source.id))).toContain(ir.blocks[2].id);
  expect(Object.keys(result.build.index.blockLocations)).toHaveLength(ir.blocks.length);
  expect(translation.blocks).toHaveLength(3); expect(translation.status).toBe('completed');
  expect(() => renderer.validateWebTranslation(ir, result.translation!)).not.toThrow();
});
it('returns a genuine source-only build when all imported proofs are implicated', () => {
  const { ir, translation } = fixture(false);
  const result = renderer.buildWebImportedReader(ir, translation);
  expect(result.translation).toBeNull(); expect(result.build.index).toMatchObject({ generationKind: 'none', translationStatus: 'pending' });
  expect(Object.keys(result.build.index.blockLocations)).toHaveLength(2);
});
it('does not swallow source graph failures during import preparation', () => {
  const { ir, translation } = fixture(true); ir.roots.push(ir.roots[0]);
  expect(() => renderer.buildWebImportedReader(ir as WebReaderIR, translation)).toThrow();
});
it('still rejects a source-only table context that cannot fit after removing imports', () => {
  const { ir, translation } = fixture(false);
  const header = ir.blocks[0]; if (header.type !== 'text') throw Error('fixture');
  header.value.content = [{ type: 'text', text: 'Original source '.repeat(20000) }];
  expect(() => renderer.buildWebReader(ir, null)).toThrow(/context.*byte budget/);
  expect(() => renderer.buildWebImportedReader(ir, translation)).toThrow(/context.*byte budget/);
});
it('keeps representable imports and their proofs unchanged', () => {
  const { ir, translation } = fixture(true); translation.blocks[0].rawText = '译文';
  const result = renderer.buildWebImportedReader(ir, translation);
  expect(result.rejectedBlockIds).toEqual([]); expect(result.translation).toBe(translation);
  expect(result.build).toEqual(renderer.buildWebReader(ir, translation));
});
