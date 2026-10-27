import { posix } from 'node:path';
import { deriveParseId } from '@pagelingo/document-bundle';
import {
  validateReaderGraph,
  type ReaderIR,
} from '@pagelingo/document-contracts';
import type { InlineContent } from '@pagelingo/translation-core';
import type {
  VerifiedP0Run,
  VerifiedPreview,
  PdfInspection,
} from './local-run.js';
import { sha256, requireInput } from './verified-input.js';
import { naturalText, blockLanguage, detectLanguage } from './language.js';
import { projectLegacyPages } from './legacy-tree.js';
export async function adaptLegacyPreview({
  run,
  preview,
  inspection,
}: {
  run: VerifiedP0Run;
  preview: VerifiedPreview;
  inspection: PdfInspection;
}): Promise<ReaderIR> {
  requireInput(
    inspection.schemaVersion === 'pagelingo-pdf-inspection/1' &&
      inspection.sourceSha256 === run.metadata.sourceSha256 &&
      inspection.pages.length === run.metadata.sourcePageCount,
    'PDF inspection identity mismatch',
  );
  const projectorVersion = `pagelingo-legacy-preview/1+${sha256(preview.manifestBytes)}`;
  const inputManifestSha256 = sha256(run.manifestBytes);
  const configSha256 = sha256(run.configBytes);
  const parseId = deriveParseId(
    run.metadata.sourceSha256,
    inputManifestSha256,
    projectorVersion,
    configSha256,
  );
  const ir: ReaderIR = {
    schemaVersion: 'reader-ir/1',
    metadata: {
      title: run.metadata.input.replace(/\.pdf$/i, ''),
      originalFilename: run.metadata.input,
      language: { language: 'und', reason: 'uncertain' },
    },
    source: {
      kind: 'pdf',
      sha256: run.metadata.sourceSha256,
      bytes: run.sourceBytes,
      pageCount: run.metadata.sourcePageCount,
    },
    parse: {
      id: parseId,
      inputManifestSha256,
      projectorVersion,
      configSha256,
      parserName: run.metadata.parser,
      parserVersion: run.config.parser.version,
      modelLockSha256: run.metadata.modelLockSha256 ?? null,
      pythonLockSha256: run.metadata.pythonLockSha256 ?? null,
      status: run.metadata.status,
      coverage:
        run.metadata.status === 'complete' &&
        run.parsedPageIndices.length === run.metadata.sourcePageCount
          ? 'full'
          : 'partial',
      requestedPageIndices: run.metadata.requestedPageIndices,
      parsedPageIndices: run.parsedPageIndices,
    },
    pages: inspection.pages,
    roots: [],
    nodes: [],
    blocks: [],
    assets: [],
    warnings: [...inspection.warnings],
  };
  if (
    ir.parse.parserVersion === null ||
    ir.parse.modelLockSha256 === null ||
    ir.parse.pythonLockSha256 === null
  )
    ir.warnings.push('upstream-version-information-missing');
  for (const [key, path] of [
    ['modelLockSha256', 'model-lock.json'],
    ['pythonLockSha256', 'python-lock.txt'],
  ] as const)
    if (ir.parse[key] && !run.files.has(path))
      ir.warnings.push(
        `upstream-${path === 'model-lock.json' ? 'model-lock' : 'python-lock'}-not-bundled`,
      );
  const ids = new Set<string>();
  const makeId = (prefix: string, source: string, path: string): string => {
    const id =
      prefix + sha256(JSON.stringify([parseId, source, path])).slice(0, 32);
    requireInput(!ids.has(id), 'Reader ID collision');
    ids.add(id);
    return id;
  };
  const { anchors, pendingLinks } = await projectLegacyPages(
    run,
    preview,
    inspection,
    ir,
    makeId,
  );
  for (const link of pendingLinks) {
    const block = ir.blocks.find((b) => b.id === link.blockId);
    if (block?.type !== 'text') continue;
    const [file, anchor] = link.href.split('#');
    const path = file
      ? posix.normalize(posix.join(posix.dirname(link.pagePath), file))
      : link.pagePath;
    const target = anchors.get(`${path}#${anchor}`);
    const binding = block.bindings.find((b) => b.id === link.id);
    if (target && binding?.kind === 'block-link') binding.blockId = target;
    else {
      const unwrap = (content: InlineContent[]): InlineContent[] =>
        content.flatMap((item) =>
          item.type === 'format'
            ? item.id === link.id
              ? unwrap(item.children)
              : [{ ...item, children: unwrap(item.children) }]
            : [item],
        );
      block.value.content = unwrap(block.value.content);
      block.bindings = block.bindings.filter((b) => b.id !== link.id);
      ir.warnings.push(`unresolved-local-link:${block.id}`);
    }
  }
  ir.metadata.language = detectLanguage(
    ir.blocks
      .filter((b) => b.type === 'text')
      .map((b) => naturalText(b.value.content))
      .join('\n'),
  );
  for (const block of ir.blocks)
    if (block.type === 'text')
      block.language = blockLanguage(block.value.content, ir.metadata.language);
  // Section titles remain real source headings, never inferred from running page furniture.
  for (const node of ir.nodes)
    if (node.kind === 'section') {
      const descend = (id: string): string | undefined => {
        const n = ir.nodes.find((n) => n.id === id)!;
        if (n.kind === 'block') return n.blockId;
        for (const c of n.children) {
          const b = descend(c);
          if (b) return b;
        }
        return undefined;
      };
      const first = node.children.length
        ? descend(node.children[0])
        : undefined;
      if (
        ir.blocks.find((b) => b.id === first)?.type === 'text' &&
        ir.blocks.some(
          (b) =>
            b.id === first && b.type === 'text' && b.value.kind === 'heading',
        )
      )
        node.headingBlockId = first;
    }
  ir.warnings = [...new Set(ir.warnings)];
  validateReaderGraph(ir);
  return ir;
}
