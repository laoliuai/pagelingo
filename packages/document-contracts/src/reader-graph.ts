import { readerContractCeilings } from './reader-limits.js';
import type { InlineContent } from '@pagelingo/translation-core';
import { readerIrSchema, type ReaderIR, type ReaderBlock, type ReaderBinding } from './reader.js';
import { requireContract as check, uniqueById } from './reader-common.js';
import type { PdfSourceRef } from './reader-source.js';

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const positiveBox = (box: readonly number[]): boolean => box[0] < box[2] && box[1] < box[3];

/** Validate in-memory IR graph and source/asset closure. Does not hash bytes or produce IDs. */
export function validateReaderGraph(input: ReaderIR): void {
  const ir = readerIrSchema.parse(input);
  const nodes = uniqueById(ir.nodes, 'node');
  const blocks = uniqueById(ir.blocks, 'block');
  const assets = uniqueById(ir.assets, 'asset');
  const usedAssets = new Set<string>();
  const paths = new Set<string>();
  for (const asset of ir.assets) {
    const key = asset.path.toLowerCase();
    check(!paths.has(key), `Asset path alias: ${asset.path}`);
    paths.add(key);
    check(asset.width * asset.height <= readerContractCeilings.maxImagePixels, `Image pixel limit: ${asset.id}`);
  }
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) check(!paths.has(segments.slice(0, i).join('/')), 'Asset path prefix conflict');
  }
  const useAsset = (id: string): void => {
    check(assets.has(id), `Unknown asset: ${id}`); usedAssets.add(id);
  };
  check(ir.pages.length === ir.source.pageCount, 'Page metadata must cover the whole source');
  const pageIndices = new Set<number>();
  const repairedPages = new Set<number>();
  for (const [physicalIndex, page] of ir.pages.entries()) {
    check(page.pageIndex === physicalIndex, 'Page metadata must follow physical page order');
    check(page.pageIndex < ir.source.pageCount && !pageIndices.has(page.pageIndex), 'Duplicate or out-of-range page metadata');
    pageIndices.add(page.pageIndex);
    check(positiveBox(page.mediaBox) && positiveBox(page.displayCropBox), 'Invalid PDF page box');
    const [x0, y0, x1, y1] = page.displayCropBox;
    check(x0 >= page.mediaBox[0] && y0 >= page.mediaBox[1] && x1 <= page.mediaBox[2] && y1 <= page.mediaBox[3], 'Display crop is outside MediaBox');
    if (page.cropBox.some((value, index) => value !== page.displayCropBox[index])) {
      repairedPages.add(page.pageIndex);
      check(ir.warnings.length > 0, 'Display crop repair requires a warning');
    }
    const rotated = page.rotation === 90 || page.rotation === 270;
    const width = x1 - x0; const height = y1 - y0;
    check(page.displayWidth === (rotated ? height : width) && page.displayHeight === (rotated ? width : height), 'Display dimensions disagree with crop/rotation');
    const matrices = { 0: [1, 0, 0, -1, -x0, y1], 90: [0, 1, 1, 0, -y0, -x0],
      180: [-1, 0, 0, 1, x1, -y0], 270: [0, -1, -1, 0, y1, x1] };
    check(page.pdfToDisplay.every((value, index) => value === matrices[page.rotation][index]), 'Invalid PDF display transform');
  }
  const pageSet = (values: number[], label: string): Set<number> => {
    const set = new Set(values);
    check(set.size === values.length && values.every(index => index < ir.source.pageCount), `Invalid ${label} pages`);
    check(values.every((value, index) => index === 0 || value > values[index - 1]), `${label} pages must be ordered`);
    return set;
  };
  const requested = pageSet(ir.parse.requestedPageIndices, 'requested');
  const parsed = pageSet(ir.parse.parsedPageIndices, 'parsed');
  check(parsed.size > 0, 'Consumable Reader IR requires at least one parsed page');
  check([...parsed].every(index => requested.has(index)), 'Parsed page was not requested');
  check((ir.parse.coverage === 'full') === (parsed.size === ir.source.pageCount && ir.parse.status === 'complete'), 'Parse coverage disagrees with parsed pages');
  check(ir.parse.status !== 'complete' || parsed.size === requested.size, 'Completed parse is missing requested pages');
  if (ir.parse.parserVersion === null || ir.parse.modelLockSha256 === null || ir.parse.pythonLockSha256 === null) {
    check(ir.warnings.length > 0, 'Missing upstream versions require a warning');
  }
  const sourceRef = (ref: PdfSourceRef): void => {
    check(parsed.has(ref.pageIndex), `Source reference outside parsed pages: ${ref.pageIndex}`);
    if (ref.precision === 'bbox') {
      check(!repairedPages.has(ref.pageIndex), 'Repaired page requires page-only source precision');
      check(positiveBox(ref.bbox), 'Source bbox must have positive area');
    }
  };
  const seenNodes = new Set<string>(); const seenBlocks = new Set<string>(); const orderedBlocks: string[] = [];
  const visit = (id: string, depth: number, parentKind?: string): void => {
    check(depth <= readerContractCeilings.maxDepth, 'Reader tree depth exceeds 32');
    check(!seenNodes.has(id), `Cycle or shared node: ${id}`);
    const node = nodes.get(id); check(node, `Unknown node: ${id}`); seenNodes.add(id);
    check(node.kind !== 'list-item' || parentKind === 'list', 'List item must belong to a list');
    if (node.kind === 'list') {
      check(node.ordered || node.start === undefined, 'Unordered list cannot have a start number');
      check(node.children.every(child => nodes.get(child)?.kind === 'list-item'), 'List children must be list items');
    }
    const subtreeStart = orderedBlocks.length;
    if (node.kind === 'block') {
      check(blocks.has(node.blockId) && !seenBlocks.has(node.blockId), `Unknown or shared block: ${node.blockId}`);
      seenBlocks.add(node.blockId); orderedBlocks.push(node.blockId);
    }
    for (const child of node.children) visit(child, depth + 1, node.kind);
    if (node.kind === 'section' && node.headingBlockId !== undefined) {
      const heading = blocks.get(node.headingBlockId);
      check(heading?.type === 'text' && heading.value.kind === 'heading', 'Section heading must reference a heading text block');
      check(orderedBlocks.slice(subtreeStart).includes(node.headingBlockId), 'Section heading must be within its section');
    }
  };
  for (const root of ir.roots) visit(root, 1);
  check(seenNodes.size === nodes.size, 'Unreachable nodes');
  check(seenBlocks.size === blocks.size, 'Unreferenced blocks');
  check(orderedBlocks.every((id, index) => id === ir.blocks[index].id), 'Blocks must follow tree reading order');
  for (const block of ir.blocks) {
    for (const ref of block.sourceRefs) sourceRef(ref);
    if (block.type === 'image') {
      useAsset(block.assetId);
      if (block.originalRegion !== null) {
        sourceRef(block.originalRegion);
        check(block.sourceRefs.some(ref => ref.pageIndex === block.originalRegion!.pageIndex), 'Original region must belong to a block source page');
      }
    } else if (block.type === 'math') {
      check(bytes(block.latex) <= readerContractCeilings.maxLatexBytes, 'LaTeX byte limit exceeded');
      if (block.fallbackAssetId) useAsset(block.fallbackAssetId);
    } else if (block.type === 'code') check(bytes(block.code) <= readerContractCeilings.maxCodeBytes, 'Code byte limit exceeded');
    else if (block.type === 'text') validateText(block, blocks, useAsset);
  }
  check(usedAssets.size === assets.size, 'Unreferenced assets');
}

function validateText(block: Extract<ReaderBlock, { type: 'text' }>, blocks: Map<string, ReaderBlock>, useAsset: (id: string) => void): void {
  check(block.id === block.value.id, 'TranslationBlock ID must equal Reader block ID');
  const bindings = uniqueById(block.bindings, 'binding'); const referenced = new Set<string>();
  let textBytes = 0;
  const visit = (content: InlineContent[], depth: number): void => {
    check(depth <= readerContractCeilings.maxDepth, 'Inline depth exceeds 32');
    for (const inline of content) {
      if (inline.type === 'text') { textBytes += bytes(inline.text); continue; }
      const binding = bindings.get(inline.id); check(binding, `Missing binding: ${inline.id}`);
      check(!referenced.has(inline.id), `Repeated inline binding: ${inline.id}`); referenced.add(inline.id);
      if (inline.type === 'format') {
        if (inline.kind === 'link') {
          check(binding.kind === 'link' || binding.kind === 'block-link', 'Link inline requires link binding');
          if (binding.kind === 'block-link') check(blocks.has(binding.blockId), 'Unknown block link');
        } else {
          check(binding.kind === 'style', 'Format inline requires style binding');
          check(inline.kind === 'style' || binding.emphasis === inline.kind, 'Format emphasis binding mismatch');
          check(Object.keys(binding).length > 2, 'Empty style binding');
        }
        visit(inline.children, depth + 1);
      } else {
        textBytes += bytes(inline.source);
        check(binding.kind === 'protected', 'Protected inline requires protected binding');
        validateProtected(inline, binding, useAsset);
      }
    }
  };
  visit(block.value.content, 1);
  check(textBytes <= readerContractCeilings.maxTextBytes, 'Text byte limit exceeded');
  check(referenced.size === bindings.size, 'Unreferenced binding');
}

function validateProtected(inline: Extract<InlineContent, { type: 'protected' }>, binding: Extract<ReaderBinding, { kind: 'protected' }>, useAsset: (id: string) => void): void {
  const object = binding.object;
  if (object.type === 'asset') {
    check(inline.kind === 'literal' && inline.source === object.alt, 'Asset inline binding mismatch'); useAsset(object.assetId);
  } else if (object.type === 'math') {
    check(inline.kind === 'math' && inline.source === object.latex, 'Math inline binding mismatch');
    check(bytes(object.latex) <= readerContractCeilings.maxLatexBytes, 'Inline LaTeX byte limit exceeded');
  } else {
    check(object.type !== 'code' || inline.kind === 'code', 'Code inline binding mismatch');
    check(object.type !== 'literal' || !['code', 'math'].includes(inline.kind), 'Literal inline binding mismatch');
    check(inline.source === object.text, 'Protected source mismatch');
    check(bytes(object.text) <= (object.type === 'code' ? readerContractCeilings.maxCodeBytes : readerContractCeilings.maxTextBytes), 'Protected text byte limit exceeded');
  }
}
