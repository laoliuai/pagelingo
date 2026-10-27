import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as contracts from '../src/index.js';
import { ir, position } from './web-fixtures.js';

test('accepts_web_refs_without_pdf_pages', () => {
  expect(contracts.webReaderIrSchema.parse(ir)).toEqual(ir);
  const webPosition = contracts.webReadingPositionSchema.parse(position);
  expect('pdfPageIndex' in webPosition).toBe(false);
  expect(contracts.webReadingPositionSchema.safeParse({ ...position, pdfPageIndex: 0 }).success).toBe(false);
  expect(contracts.webReaderIrSchema.safeParse({ ...ir, pages: [] }).success).toBe(false);
});
test('preserves_pdf_v1_shape', () => {
  const value = JSON.parse(readFileSync(new URL('../fixtures/reader-v1/source-ir.json', import.meta.url), 'utf8'));
  expect(contracts.readerIrSchema.parse(value)).toEqual(value);
  expect(value.schemaVersion).toBe('reader-ir/1');
  expect(contracts.readingPositionSchema.safeParse({ ...position, pdfPageIndex: 0, contentMode: 'source' }).success).toBe(true);
});
test('rejects duplicate IDs and deep JSON before recursive SDK validation', () => {
  expect(contracts.webReaderIrSchema.safeParse({ ...ir, blocks: [...ir.blocks, ...ir.blocks] }).success).toBe(false);
  let content: unknown[] = [];
  for (let i = 0; i < 140; i++) content = [{ type: 'format', id: String(i), kind: 'strong', children: content }];
  expect(() => contracts.webReaderIrSchema.parse({ ...ir, blocks: [{ ...ir.blocks[0], type: 'text', value: { id: ir.blocks[0].id, content }, bindings: [], safeMath: [], language: ir.metadata.language }] })).toThrow(/depth/i);
});
test('binds SafeMathAst only to existing protected asset or literal bindings', () => {
  const binding = { kind: 'protected', id: 'formula', object: { type: 'literal', text: 'x' } };
  const ast = { kind: 'mathml', roots: ['math'], nodes: [{ id: 'math', tag: 'math', attributes: {}, children: ['text'] }, { id: 'text', tag: 'mi', attributes: {}, children: [], text: 'x' }] };
  const block = { ...ir.blocks[0], type: 'text', value: { id: ir.blocks[0].id, kind: 'paragraph', content: [{ type: 'protected', id: 'formula', kind: 'literal', source: 'x' }] }, language: ir.metadata.language, bindings: [binding], safeMath: [{ bindingId: 'formula', ast }] };
  expect(contracts.webReaderBlockSchema.safeParse(block).success).toBe(true);
  expect(contracts.webReaderBlockSchema.safeParse({ ...block, bindings: [] }).success).toBe(false);
  expect(contracts.webReaderBlockSchema.safeParse({ ...block, bindings: [{ ...binding, object: { type: 'code', text: 'x' } }] }).success).toBe(false);
});
test('accepts table cell references and rejects PDF fields and unsafe table spans', () => {
  const cell = { id: ir.nodes[0].id, children: [], kind: 'table-cell', header: false, rowSpan: 1, colSpan: 1, scope: null, headerNodeIds: [] };
  expect(contracts.webReaderNodeSchema.parse(cell)).toEqual(cell);
  expect(contracts.webReaderNodeSchema.safeParse({ ...cell, colSpan: 0 }).success).toBe(false);
  expect(contracts.webReaderNodeSchema.safeParse({ ...cell, pageIndices: [0] }).success).toBe(false);
});
