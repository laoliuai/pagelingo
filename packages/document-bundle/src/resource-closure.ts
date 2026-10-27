import type {
  BundleLimits,
  DocumentBundleManifest,
  ReaderIR,
  ReaderTranslation,
} from '@pagelingo/document-contracts';
import { stableJson } from '@pagelingo/translation-core';
import { check } from './errors.js';
import { checkSize } from './limits.js';
import { deriveParseId } from './manifest.js';

export function checkIdentities(
  manifest: DocumentBundleManifest,
  ir: ReaderIR,
  translation: ReaderTranslation,
): void {
  check(stableJson(manifest.source) === stableJson(ir.source));
  check(
    manifest.title === ir.metadata.title &&
      manifest.originalFilename === ir.metadata.originalFilename,
  );
  check(
    Object.entries(manifest.parse).every(
      ([key, value]) => ir.parse[key as keyof ReaderIR['parse']] === value,
    ),
  );
  check(
    ir.parse.id ===
      deriveParseId(
        ir.source.sha256,
        ir.parse.inputManifestSha256,
        ir.parse.projectorVersion,
        ir.parse.configSha256,
      ),
  );
  check(
    translation.sourceSha256 === ir.source.sha256 &&
      translation.parseId === ir.parse.id &&
      translation.readerIrSha256 === manifest.readerIrSha256,
  );
  check(
    translation.id === manifest.translation.id &&
      translation.status === manifest.translation.status &&
      translation.generationKind === manifest.translation.generationKind,
  );
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  for (const asset of ir.assets) {
    const file = files.get(asset.path);
    check(file, 'BUNDLE_MISSING_RESOURCE');
    check(
      file.role === 'asset' &&
        file.sha256 === asset.sha256 &&
        file.bytes === asset.bytes &&
        file.mediaType === asset.mediaType,
    );
  }
  for (const [kind, path] of [
    ['model', 'provenance/model-lock.json'],
    ['python', 'provenance/python-lock.txt'],
  ] as const) {
    const expected =
      kind === 'model' ? ir.parse.modelLockSha256 : ir.parse.pythonLockSha256;
    const file = files.get(path);
    if (file)
      check(
        expected !== null &&
          file.sha256 === expected &&
          file.role === 'provenance',
      );
    else if (expected !== null)
      check(ir.warnings.includes(`upstream-${kind}-lock-not-bundled`));
  }
}
/** Additional runtime caps are applied before invoking graph/SDK/renderer traversals. */
export function checkReaderLimits(
  ir: ReaderIR,
  translation: ReaderTranslation,
  limits: BundleLimits,
): void {
  checkSize(ir.nodes.length, limits.maxNodes);
  checkSize(ir.blocks.length, limits.maxBlocks);
  const nodes = new Map(ir.nodes.map((n) => [n.id, n]));
  const stack = ir.roots.map((id) => ({ id, depth: 1 })),
    visited = new Set<string>();
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    checkSize(depth, limits.maxDepth);
    check(!visited.has(id));
    visited.add(id);
    const node = nodes.get(id);
    check(node);
    for (const child of node.children)
      stack.push({ id: child, depth: depth + 1 });
  }
  const bytes = (text: string, limit: number): void =>
    checkSize(Buffer.byteLength(text), limit);
  for (const block of ir.blocks) {
    if (block.type === 'code') bytes(block.code, limits.maxCodeBytes);
    if (block.type === 'math') bytes(block.latex, limits.maxLatexBytes);
    if (block.type === 'text') {
      let total = 0;
      const inlines = block.value.content.map((value) => ({ value, depth: 1 }));
      while (inlines.length) {
        const { value, depth } = inlines.pop()!;
        checkSize(depth, limits.maxDepth);
        if (value.type === 'format') {
          for (const child of value.children)
            inlines.push({ value: child, depth: depth + 1 });
        } else {
          total += Buffer.byteLength(
            value.type === 'text' ? value.text : value.source,
          );
          checkSize(total, limits.maxTextBytes);
        }
      }
      for (const binding of block.bindings)
        if (binding.kind === 'protected') {
          const object = binding.object;
          if (object.type === 'math') bytes(object.latex, limits.maxLatexBytes);
          else if (object.type === 'code')
            bytes(object.text, limits.maxCodeBytes);
          else if (object.type === 'literal')
            bytes(object.text, limits.maxTextBytes);
        }
    }
  }
  for (const result of translation.blocks)
    if (result.status === 'translated')
      bytes(result.rawText, limits.maxTextBytes);
  for (const result of translation.units)
    if (result.status === 'completed')
      bytes(result.rawText, limits.maxTextBytes);
  for (const asset of ir.assets) {
    checkSize(asset.width, limits.maxImageDimension);
    checkSize(asset.height, limits.maxImageDimension);
    checkSize(asset.width * asset.height, limits.maxImagePixels);
  }
}
