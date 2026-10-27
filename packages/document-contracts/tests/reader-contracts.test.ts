import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  readerIrSchema, readerTranslationSchema, documentBundleManifestSchema,
  readingPositionSchema, readingProgressUpdateSchema, bundleLimitsSchema, defaultBundleLimits,
  readerChunkIdSchema, createBundleImportRequestSchema, bundleImportSchema, bundleLimitsOverrideSchema,
  readerVersionSummarySchema, readerVersionListSchema, readerVersionListQuerySchema,
  validateReaderGraph, validateReaderTranslationReferences,
  type ReaderIR, type ReaderTranslation,
} from '../src/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/reader-v1/${name}.json`, import.meta.url), 'utf8'));
const ir = (): ReaderIR => readerIrSchema.parse(fixture('source-ir'));
const translation = (): ReaderTranslation => readerTranslationSchema.parse(fixture('translation'));
const clone = <T>(value: T): T => structuredClone(value);

describe('Reader graph contract', () => {
  it('rejects_graph_aliases_and_binding_mismatches', () => {
    const original = ir();
    expect(() => validateReaderGraph(original)).not.toThrow();
    const mutations: Array<(value: ReaderIR) => void> = [
      value => { value.nodes.push(clone(value.nodes[0])); },
      value => { value.roots.push(value.roots[0]); },
      value => { value.nodes[0].children.push(value.nodes[0].id); },
      value => { value.nodes[1].children.push(value.nodes[2].id); },
      value => { value.blocks.push(clone(value.blocks[0])); },
      value => { value.assets.push({ ...value.assets[0], id: 'unused' }); },
      value => { value.assets[0].path = 'assets/../bad.png'; },
      value => { value.blocks[0].sourceRefs[0].pageIndex = 99; },
      value => { if (value.blocks[0].type === 'text') value.blocks[0].value.id = value.blocks[1].id; },
      value => { if (value.blocks[0].type === 'text') value.blocks[0].bindings = []; },
    ];
    for (const mutate of mutations) {
      const value = clone(original); mutate(value);
      expect(() => validateReaderGraph(value)).toThrow();
    }
  });

  it('retains_distinct_ids_for_repeated_text', () => {
    const value = ir();
    const texts = value.blocks.filter(block => block.type === 'text');
    expect(texts[1].value.content).toEqual(texts[2].value.content);
    expect(texts[1].id).not.toBe(texts[2].id);
    expect(() => validateReaderGraph(value)).not.toThrow();
  });

  it('preserves cross-page and page-only references without fabricated boxes', () => {
    const value = ir();
    expect(value.blocks[1].sourceRefs).toEqual([{ pageIndex: 0, precision: 'page' }, { pageIndex: 1, precision: 'page' }]);
    const bad = clone(value);
    Object.assign(bad.blocks[1].sourceRefs[0], { bbox: [0, 0, 1, 1] });
    expect(readerIrSchema.safeParse(bad).success).toBe(false);
    bad.blocks[1].sourceRefs = [{ pageIndex: 0, precision: 'bbox', bbox: [0.5, 0, 0.2, 1] }];
    expect(() => validateReaderGraph(bad)).toThrow();
  });

  it('keeps independent golden boxes for all crop rotations', () => {
    const value = ir();
    const goldens = [
      [40 / 360, 260 / 420, 120 / 360, 360 / 420],
      [60 / 420, 40 / 360, 160 / 420, 120 / 360],
      [240 / 360, 60 / 420, 320 / 360, 160 / 420],
      [260 / 420, 240 / 360, 360 / 420, 320 / 360],
    ];
    const boxes = fixture('rotation-goldens') as Array<{ pageIndex: number; bbox: number[] }>;
    for (const [index, page] of value.pages.entries()) {
      const [a, b, c, d, e, f] = page.pdfToDisplay;
      const points = [[60, 100], [140, 100], [60, 200], [140, 200]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const actual = [Math.min(...points.map(p => p[0])) / page.displayWidth, Math.min(...points.map(p => p[1])) / page.displayHeight,
        Math.max(...points.map(p => p[0])) / page.displayWidth, Math.max(...points.map(p => p[1])) / page.displayHeight];
      expect(boxes[index]).toEqual({ pageIndex: index, bbox: goldens[index] });
      expect(actual).toEqual(goldens[index]);
    }
  });

  it('checks page coverage, canonical IDs, bounded nesting, links and image limits', () => {
    const value = ir();
    for (const patch of [{ pages: value.pages.slice(1) }, { parse: { ...value.parse, parsedPageIndices: [0, 0, 1, 2, 3] } }]) {
      expect(() => validateReaderGraph({ ...value, ...patch })).toThrow();
    }
    expect(readerIrSchema.safeParse({ ...value, parse: { ...value.parse, id: 'p_fake' } }).success).toBe(false);
    const bad = clone(value);
    if (bad.blocks[0].type === 'text') bad.blocks[0].bindings[0] = { kind: 'link', id: 'strong', href: 'javascript:alert(1)' };
    expect(readerIrSchema.safeParse(bad).success).toBe(false);
    expect(readerIrSchema.safeParse({ ...value, assets: [{ ...value.assets[0], width: 16385 }] }).success).toBe(false);
    const deep = clone(value);
    let children: unknown[] = [];
    for (let i = 0; i < 140; i++) children = [{ type: 'format', id: `f${i}`, kind: 'strong', children }];
    if (deep.blocks[0].type === 'text') deep.blocks[0].value.content = children as never;
    expect(() => readerIrSchema.parse(deep)).toThrow(/depth/i);
  });
});

describe('Reader translation references', () => {
  it('requires_explicit_untranslated_results', () => {
    const source = ir(); const result = translation();
    expect(() => validateReaderTranslationReferences(source, result)).not.toThrow();
    const missing = clone(result); missing.blocks.pop();
    expect(() => validateReaderTranslationReferences(source, missing)).toThrow();
    for (const patch of [
      { sourceSha256: 'f'.repeat(64) }, { parseId: `p_${'f'.repeat(64)}` },
      { selectionBlockIds: [...result.selectionBlockIds].reverse() },
      { blocks: [...result.blocks, result.blocks[0]] }, { status: 'completed' as const },
      { units: [...result.units, ...result.units] },
    ]) expect(() => validateReaderTranslationReferences(source, { ...result, ...patch })).toThrow();
  });

  it('accepts Chinese not-required and distinguishes pending, partial, completed and mock', () => {
    const source = ir(); const result = translation();
    for (const block of source.blocks) if (block.type === 'text') block.language = { language: 'zh', reason: 'han-only' };
    source.metadata.language = { language: 'zh', reason: 'han-only' };
    const chinese = { ...result, generationKind: 'none' as const, selectionBlockIds: [], status: 'not-required' as const, units: [],
      blocks: result.blocks.map(block => ({ blockId: block.blockId, status: 'source-only' as const, reason: 'language-not-required' as const })) };
    expect(() => validateReaderTranslationReferences(source, chinese)).not.toThrow();
    expect(() => validateReaderTranslationReferences(ir(), chinese)).toThrow();
    const completed: ReaderTranslation = { ...result, generationKind: 'mock', status: 'completed',
      blocks: result.blocks.map(block => ({ blockId: block.blockId, status: 'translated', rawText: '模拟译文' })),
      units: result.units.map(unit => ({ ...unit, status: 'completed', rawText: '模拟译文' })) };
    expect(() => validateReaderTranslationReferences(ir(), completed)).not.toThrow();
    expect(readerTranslationSchema.safeParse({ ...completed, provider: { ...completed.provider, apiKey: 'secret' } }).success).toBe(false);
    expect(readerTranslationSchema.safeParse({ ...completed, units: [{ ...completed.units[0], rawText: undefined }] }).success).toBe(false);
    expect(() => validateReaderTranslationReferences(ir(), { ...completed, generationKind: 'none' })).toThrow();
  });
});

it('requires CAS progress, bounded offsets and server source/version identifiers', () => {
  const position = { readerVersionId: '00000000-0000-4000-8000-000000000001', sourceVersionId: '00000000-0000-4000-8000-000000000002',
    parseId: `p_${'a'.repeat(64)}`, blockId: null, blockOffset: 0, pdfPageIndex: 0, view: 'split', contentMode: 'translation' };
  expect(readingPositionSchema.safeParse(position).success).toBe(true);
  expect(readingPositionSchema.safeParse({ ...position, blockOffset: 1.01 }).success).toBe(false);
  expect(readingProgressUpdateSchema.safeParse({ position, expectedRevision: 0 }).success).toBe(true);
  expect(readingProgressUpdateSchema.safeParse({ position }).success).toBe(false);
  expect(readingProgressUpdateSchema.safeParse({ position, expectedRevision: 0, ownerId: 'forged' }).success).toBe(false);
});

it('enforces manifest shape, canonical paths and positive safe limits without claiming byte verification', () => {
  const manifest = documentBundleManifestSchema.parse(fixture('manifest'));
  expect(manifest.schemaVersion).toBe('pagelingo-document-bundle/1');
  for (const path of ['../x', 'a//x', '/x', 'a\\x', 'a/%20x', 'a/CON.txt', 'a/./x', 'a/x:1', 'a/é']) {
    expect(documentBundleManifestSchema.safeParse({ ...manifest, files: [{ ...manifest.files[0], path }] }).success).toBe(false);
  }
  expect(documentBundleManifestSchema.safeParse({ ...manifest, apiKey: 'secret' }).success).toBe(false);
  expect(bundleLimitsSchema.parse(defaultBundleLimits).maxExpandedBytes).toBe(1073741824);
  for (const maxFiles of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(bundleLimitsSchema.safeParse({ ...defaultBundleLimits, maxFiles }).success).toBe(false);
});

it('rejects original-region references on a different source page', () => {
  const source = ir();
  const wrongRegion = clone(source);
  const image = wrongRegion.blocks.find(block => block.type === 'image')!;
  image.originalRegion = { pageIndex: 0, precision: 'bbox', bbox: [0, 0, 1, 1] };
  expect(() => validateReaderGraph(wrongRegion)).toThrow();
});

it('bounds translated UTF-8 text bytes', () => {
  const source = ir(); const result = translation();
  const huge = clone(result);
  huge.blocks[0] = { blockId: huge.blocks[0].blockId, status: 'translated', rawText: '中'.repeat(200000) };
  huge.units[0] = { ...huge.units[0], status: 'completed', rawText: 'done' };
  huge.status = 'partial'; huge.generationKind = 'mock';
  expect(() => validateReaderTranslationReferences(source, huge)).toThrow();
});

it('rejects pending when all required results are already cancelled', () => {
  const source = ir(); const result = translation();
  const cancelled = clone(result);
  cancelled.status = 'pending';
  cancelled.blocks = cancelled.blocks.map(block => ({ blockId: block.blockId, status: 'source-only', reason: 'cancelled' }));
  cancelled.units = cancelled.units.map(unit => ({ ...unit, status: 'cancelled' }));
  expect(() => validateReaderTranslationReferences(source, cancelled)).toThrow();
});

it('distributes JSON Schemas matching strict Zod shapes with Ajv 2020 and formats', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  // CommonJS plugin exposes its callable default on the NodeNext module wrapper.
  const addFormats = (await import('ajv-formats')).default.default;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const cases = [
    { name: 'reader-ir', schema: readerIrSchema, value: fixture('source-ir') },
    { name: 'reader-translation', schema: readerTranslationSchema, value: fixture('translation') },
    { name: 'document-bundle', schema: documentBundleManifestSchema, value: fixture('manifest') },
  ];
  for (const { name, schema, value } of cases) {
    const jsonSchema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
    const validate = ajv.compile(jsonSchema);
    const nestedInvalid = clone(value) as Record<string, unknown>;
    if (name === 'reader-ir') {
      const source = nestedInvalid as unknown as ReaderIR;
      if (source.blocks[0].type === 'text') source.blocks[0].bindings[0] = { kind: 'link', id: 'strong', href: 'http://#' };
    } else if (name === 'reader-translation') Object.assign(nestedInvalid.provider as object, { apiKey: 'secret' });
    else (nestedInvalid.files as Array<{ path: string }>)[0].path = '../source.pdf';
    for (const candidate of [value, nestedInvalid, { ...(value as object), schemaVersion: 'future/99' }, { ...(value as object), ownerId: 'forged' }, null]) {
      expect(validate(candidate), JSON.stringify(validate.errors)).toBe(schema.safeParse(candidate).success);
    }
  }
});

it('rejects malformed navigation URLs', () => {
  const badLink = ir();
  if (badLink.blocks[0].type === 'text') badLink.blocks[0].bindings[0] = { kind: 'link', id: 'strong', href: 'http://#' };
  expect(readerIrSchema.safeParse(badLink).success).toBe(false);
});

it('downgrades display repairs to page-only sources', () => {
  const repaired = ir();
  repaired.pages[2].cropBox = [-10, 40, 380, 460];
  expect(() => validateReaderGraph(repaired)).toThrow();
  for (const block of repaired.blocks) for (const ref of block.sourceRefs) if (ref.pageIndex === 2) Object.assign(ref, { precision: 'page' });
  for (const block of repaired.blocks) block.sourceRefs = block.sourceRefs.map(ref => ref.precision === 'page' ? { pageIndex: ref.pageIndex, precision: 'page' } : ref);
  expect(() => validateReaderGraph(repaired)).not.toThrow();
});

it('reports subset and incomplete parser runs as partial readable coverage', () => {
  const incomplete = ir();
  incomplete.parse.status = 'partial';
  expect(() => validateReaderGraph(incomplete)).toThrow();
  incomplete.parse.coverage = 'partial';
  expect(() => validateReaderGraph(incomplete)).not.toThrow();
  const subset = ir();
  subset.parse.requestedPageIndices = [0, 1, 2]; subset.parse.parsedPageIndices = [0, 1, 2];
  for (const block of subset.blocks) block.sourceRefs = block.sourceRefs.map(ref => ({ pageIndex: Math.min(2, ref.pageIndex), precision: 'page' }));
  expect(() => validateReaderGraph(subset)).toThrow();
  subset.parse.coverage = 'partial';
  expect(() => validateReaderGraph(subset)).not.toThrow();
});

it('bounds canonical chunk IDs and prevents duplicate PDF-limit configuration', () => {
  expect(readerChunkIdSchema.safeParse('c_000001').success).toBe(true);
  expect(readerChunkIdSchema.safeParse('c_000000').success).toBe(false);
  expect(readerChunkIdSchema.safeParse('c_1').success).toBe(false);
  expect(bundleLimitsOverrideSchema.safeParse({ maxPdfBytes: 1024 }).success).toBe(false);
  expect(bundleLimitsOverrideSchema.safeParse({ maxFiles: 100 }).success).toBe(true);
});

it('does not promote wholly failed parser runs into consumable Reader IR', () => {
  const source = ir();
  expect(readerIrSchema.safeParse({ ...source, parse: { ...source.parse, status: 'failed', coverage: 'partial', parsedPageIndices: [] } }).success).toBe(false);
});

it('matches source-only block reasons to unfinished units', () => {
  const source = ir(); const result = translation();
  result.units[0] = { ...result.units[0], status: 'failed', error: 'provider failed' };
  expect(() => validateReaderTranslationReferences(source, result)).toThrow();
  result.blocks[0] = { blockId: result.blocks[0].blockId, status: 'source-only', reason: 'failed' };
  expect(() => validateReaderTranslationReferences(source, result)).not.toThrow();
});

it('rejects empty image payload claims and excessive inline depth', () => {
  const source = ir();
  expect(readerIrSchema.safeParse({ ...source, assets: [{ ...source.assets[0], bytes: 0 }] }).success).toBe(false);
  if (source.blocks[0].type !== 'text') throw new Error('Expected text fixture');
  const block = source.blocks[0];
  block.bindings = [];
  let content = [{ type: 'text' as const, text: 'nested' }] as typeof block.value.content;
  for (let i = 0; i < 33; i++) {
    content = [{ type: 'format', id: `f${i}`, kind: 'strong', children: content }];
    block.bindings.push({ kind: 'style', id: `f${i}`, emphasis: 'strong' });
  }
  block.value.content = content;
  expect(() => validateReaderGraph(source)).toThrow(/depth/i);
});

it('rejects not-required results that still claim pending work', () => {
  const source = ir(); const result = translation();
  for (const block of source.blocks) if (block.type === 'text') block.language = { language: 'zh', reason: 'han-only' };
  result.selectionBlockIds = []; result.units = []; result.status = 'not-required';
  expect(() => validateReaderTranslationReferences(source, result)).toThrow();
});

it('keeps physical page metadata in order and requires usable partial parse pages', () => {
  const unordered = ir();
  [unordered.pages[0], unordered.pages[1]] = [unordered.pages[1], unordered.pages[0]];
  expect(() => validateReaderGraph(unordered)).toThrow();
  const empty = ir();
  empty.parse.status = 'partial'; empty.parse.coverage = 'partial'; empty.parse.parsedPageIndices = [];
  empty.roots = []; empty.nodes = []; empty.blocks = []; empty.assets = [];
  expect(() => validateReaderGraph(empty)).toThrow();
});

it('only tightens versioned structural ceilings while allowing larger operational byte budgets', () => {
  for (const invalid of [
    { maxNodes: 100001 }, { maxBlocks: 100001 }, { maxDepth: 33 }, { maxJsonDepth: 129 },
    { maxPathBytes: 241 }, { maxTextBytes: 524289 }, { maxCodeBytes: 524289 }, { maxLatexBytes: 16385 },
    { maxImagePixels: 40000001 }, { maxImageDimension: 16385 }, { maxFiles: 10001 },
  ]) expect(bundleLimitsOverrideSchema.safeParse(invalid).success).toBe(false);
  expect(bundleLimitsOverrideSchema.safeParse({ maxNodes: 1000, maxDepth: 16, maxExpandedBytes: 2147483648 }).success).toBe(true);
});

it('preserves invalid original CropBox evidence when a valid effective crop is page-only', () => {
  const repaired = ir();
  repaired.pages[2].cropBox = [20, 40, 20, 40];
  for (const block of repaired.blocks) block.sourceRefs = block.sourceRefs.map(ref => ref.pageIndex === 2 ? { pageIndex: 2, precision: 'page' } : ref);
  expect(() => validateReaderGraph(repaired)).not.toThrow();
});

describe('frozen bundle import API', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const timestamps = { createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:01:00.000Z' };

  it('creates new and targeted imports without accepting client ownership or obsolete fields', () => {
    expect(createBundleImportRequestSchema.parse({})).toEqual({});
    expect(createBundleImportRequestSchema.parse({ targetDocumentId: id })).toEqual({ targetDocumentId: id });
    for (const invalid of [{ documentId: null }, { targetDocumentId: null }, { targetDocumentId: 'bad' }, { ownerId: id }, { targetDocumentId: id, ownerId: id }]) {
      expect(createBundleImportRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('preserves distinct creation and receiving phases and required fencing epochs', () => {
    const base = { id, epoch: 0, ...timestamps };
    for (const status of ['created', 'receiving', 'validating', 'completed', 'failed', 'cancelled']) {
      const value = { ...base, status };
      expect(bundleImportSchema.parse(value)).toEqual(value);
    }
    const completed = { ...base, status: 'completed', epoch: 2, documentId: id, readerVersionId: id };
    expect(bundleImportSchema.parse(completed)).toEqual(completed);
    const failed = { ...base, status: 'failed', errorCode: 'BUNDLE_IDENTITY_CONFLICT' };
    expect(bundleImportSchema.parse(failed)).toEqual(failed);
    for (const patch of [
      { epoch: undefined }, { epoch: -1 }, { epoch: 0.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 },
      { status: 'uploading' }, { status: 'publishing' }, { documentId: null }, { readerVersionId: null },
      { errorCode: null }, { errorCode: '' }, { error: { code: 'failed', message: 'old protocol' } }, { ownerId: id },
    ]) expect(bundleImportSchema.safeParse({ ...base, status: 'created', ...patch }).success).toBe(false);
  });
});

describe('Reader version-list API', () => {
  const version = {
    id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-27T00:00:00.000Z',
    sourceVersionId: '00000000-0000-4000-8000-000000000002', parseId: `p_${'a'.repeat(64)}`,
    translationStatus: 'partial', parseCoverage: 'partial', warnings: ['Some units remain untranslated'],
  };

  it('exports strict version summaries and paginated results', () => {
    expect(readerVersionSummarySchema.parse(version)).toEqual(version);
    const list = { items: [version], total: 1, page: 1, pageSize: 20 };
    expect(readerVersionListSchema.parse(list)).toEqual(list);
    for (const patch of [{ id: 'bad' }, { createdAt: 'today' }, { sourceVersionId: null }, { parseId: 'p_bad' },
      { translationStatus: 'ready' }, { parseCoverage: 'sample' }, { warnings: [null] }, { ownerId: version.id }]) {
      expect(readerVersionSummarySchema.safeParse({ ...version, ...patch }).success).toBe(false);
    }
    for (const patch of [{ total: -1 }, { page: 0 }, { pageSize: 101 }, { ownerId: version.id }]) {
      expect(readerVersionListSchema.safeParse({ ...list, ...patch }).success).toBe(false);
    }
  });

  it('defaults version pagination to 1/20 and accepts at most 100 entries per page', () => {
    expect(readerVersionListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(readerVersionListQuerySchema.parse({ page: '2', pageSize: '100' })).toEqual({ page: 2, pageSize: 100 });
    for (const query of [{ page: 0 }, { pageSize: 101 }, { pageSize: 0 }, { page: true }, { page: [] }, { page: '1.5' }, { q: 'unexpected' }, { ownerId: version.id }]) {
      expect(readerVersionListQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

it('shares portable link shapes with JSON Schema and retains URL legality in graph validation', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const addFormats = (await import('ajv-formats')).default.default;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const jsonSchema = JSON.parse(readFileSync(new URL('../schemas/reader-ir.schema.json', import.meta.url), 'utf8'));
  const validate = ajv.compile(jsonSchema);
  const cases = fixture('link-shapes') as Array<{ href: string; shapeValid: boolean; graphValid: boolean }>;
  for (const { href, shapeValid, graphValid } of cases) {
    const source = ir();
    const block = source.blocks[0];
    if (block.type !== 'text' || block.value.content[0].type !== 'format') throw new Error('Expected formatted heading fixture');
    block.value.content[0].kind = 'link';
    block.bindings = [{ kind: 'link', id: block.value.content[0].id, href }];
    const zodValid = readerIrSchema.safeParse(source).success;
    const jsonValid = validate(source);
    expect(zodValid, `Zod / JSON Schema shape agreement for ${JSON.stringify(href)}`).toBe(jsonValid);
    expect(zodValid, `Portable shape for ${JSON.stringify(href)}`).toBe(shapeValid);
    if (graphValid) expect(() => validateReaderGraph(source), href).not.toThrow();
    else expect(() => validateReaderGraph(source), href).toThrow();
  }
});
