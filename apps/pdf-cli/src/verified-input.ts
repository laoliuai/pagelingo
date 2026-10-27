import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import {
  parseParserConfig,
  serializeBundleJson,
} from '@pagelingo/document-bundle';
import type {
  VerifiedFiles,
  VerifiedP0Run,
  VerifiedPreview,
  ManifestEntry,
  P0Metadata,
  RawDocument,
  PreviewMetadata,
  SourceLayout,
} from './local-run.js';
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export function requireInput(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export async function readLocal(root: string, path: string): Promise<Buffer> {
  requireInput(
    path.length > 0 &&
      !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.split('/').some((p) => !p || p === '.' || p === '..'),
    'Unsafe local member path',
  );
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    requireInput(
      !(await lstat(current)).isSymbolicLink(),
      'Symlink local input',
    );
  }
  requireInput((await lstat(current)).isFile(), 'Non-file local input');
  const target = await realpath(current);
  const rel = relative(await realpath(root), target);
  requireInput(
    !rel.startsWith('../') && !isAbsolute(rel),
    'Local member escaped root',
  );
  return readFile(target);
}
export async function readVerified(
  input: VerifiedFiles,
  path: string,
): Promise<Buffer> {
  const entry = input.files.get(path);
  requireInput(entry, `Unlisted input member: ${path}`);
  const bytes = await readLocal(input.root, path);
  requireInput(
    bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
    `Input checksum mismatch: ${path}`,
  );
  return bytes;
}
export async function verifyFiles(
  root: string,
  schema: string,
): Promise<VerifiedFiles> {
  const manifestBytes = await readLocal(root, 'manifest.json');
  const manifest = JSON.parse(manifestBytes.toString());
  requireInput(
    manifest.schemaVersion === schema && Array.isArray(manifest.files),
    'Unsupported input manifest',
  );
  const files = new Map<string, ManifestEntry>();
  const aliases = new Set<string>();
  for (const entry of manifest.files as ManifestEntry[]) {
    requireInput(
      typeof entry.path === 'string' &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        /^[a-f0-9]{64}$/.test(entry.sha256),
      'Invalid manifest entry',
    );
    requireInput(
      !aliases.has(entry.path.toLowerCase()),
      'Duplicate manifest member',
    );
    aliases.add(entry.path.toLowerCase());
    files.set(entry.path, entry);
  }
  const result = { root: resolve(root), manifestBytes, files };
  for (const path of files.keys()) await readVerified(result, path);
  return result;
}
export async function verifyP0Run(
  root: string,
  sourceHash: string,
): Promise<VerifiedP0Run> {
  const files = await verifyFiles(root, 'pagelingo-run-files/1');
  const metadata = JSON.parse(
    (await readVerified(files, 'run.json')).toString(),
  ) as P0Metadata;
  requireInput(
    metadata.schemaVersion === 'pagelingo-benchmark-run/1' &&
      metadata.parser === 'mineru',
    'Only verified MinerU P0 runs are supported',
  );
  requireInput(
    ['complete', 'partial'].includes(metadata.status),
    'Failed P0 run is not consumable',
  );
  requireInput(
    metadata.sourceSha256 === sourceHash &&
      sha256(await readVerified(files, 'source.pdf')) === sourceHash,
    'Source hash mismatch',
  );
  requireInput(
    Array.isArray(metadata.requestedPageIndices) &&
      Number.isSafeInteger(metadata.sourcePageCount) &&
      metadata.sourcePageCount > 0,
    'Invalid source pages',
  );
  requireInput(
    metadata.input.length > 0 &&
      !/[\\/\x00-\x1f\x7f]/.test(metadata.input) &&
      !['.', '..'].includes(metadata.input),
    'Invalid original filename',
  );
  const raw = JSON.parse(
    (await readVerified(files, 'raw.json')).toString(),
  ) as RawDocument;
  requireInput(
    Array.isArray(raw.pages) && raw.pages.length > 0,
    'Missing raw pages',
  );
  const parsedPageIndices = raw.pages
    .map((p) => {
      requireInput(
        Number.isInteger(p.page_idx) &&
          p.page_idx >= 0 &&
          p.page_idx < metadata.requestedPageIndices.length &&
          Array.isArray(p.blocks),
        'Invalid raw page mapping',
      );
      return metadata.requestedPageIndices[p.page_idx];
    })
    .sort((a, b) => a - b);
  const allowed = [
    'tier',
    'smallBackend',
    'device',
    'parseMode',
    'imageAnalysis',
    'vlm',
    'pageRange',
    'threadsRequested',
    'onnxIntraOpThreadsRequested',
    'onnxInterOpThreadsRequested',
  ];
  const options = Object.fromEntries(
    Object.entries(metadata.worker?.config ?? {}).filter(([key]) =>
      allowed.includes(key),
    ),
  );
  const config = parseParserConfig({
    schemaVersion: 'pagelingo-parser-config/1',
    parser: {
      name: metadata.parser,
      version: metadata.worker?.versions?.mineru ?? null,
    },
    options,
  });
  return {
    ...files,
    metadata,
    raw,
    parsedPageIndices,
    config,
    configBytes: serializeBundleJson(config),
    sourceBytes: files.files.get('source.pdf')!.bytes,
  };
}
export async function verifyPreview(
  root: string,
  run: VerifiedP0Run,
): Promise<VerifiedPreview> {
  const files = await verifyFiles(root, 'pagelingo-static-preview-files/1');
  const metadata = JSON.parse(
    (await readVerified(files, 'preview.json')).toString(),
  ) as PreviewMetadata;
  requireInput(
    ['pagelingo-static-preview/0.5', 'pagelingo-static-preview/0.6'].includes(
      metadata.schemaVersion,
    ),
    'Unsupported legacy preview version',
  );
  requireInput(
    metadata.sourceRunId === run.metadata.runId &&
      metadata.sourceSha256 === run.metadata.sourceSha256 &&
      metadata.sourceManifestSha256 === sha256(run.manifestBytes),
    'Preview lineage hash mismatch',
  );
  requireInput(
    metadata.sourceStatus === run.metadata.status &&
      metadata.coverage === run.metadata.coverage &&
      metadata.sourcePageCount === run.metadata.sourcePageCount &&
      JSON.stringify(metadata.requestedPageIndices) ===
        JSON.stringify(run.metadata.requestedPageIndices),
    'Preview coverage mismatch',
  );
  requireInput(
    metadata.translated === false,
    'Only original-language previews can be adapted',
  );
  requireInput(
    Array.isArray(metadata.pages) &&
      metadata.pages.length === run.parsedPageIndices.length &&
      new Set(metadata.pages.map((p) => p.sourcePageIndex)).size ===
        metadata.pages.length,
    'Invalid preview pages',
  );
  for (const p of metadata.pages)
    requireInput(
      run.parsedPageIndices.includes(p.sourcePageIndex) &&
        run.metadata.requestedPageIndices[p.parsedPageIndex] ===
          p.sourcePageIndex &&
        files.files.has(p.path),
      'Invalid preview page mapping',
    );
  const layout = JSON.parse(
    (await readVerified(files, 'source-layout.json')).toString(),
  ) as SourceLayout;
  requireInput(
    layout.sourceRunId === metadata.sourceRunId &&
      layout.sourceSha256 === metadata.sourceSha256 &&
      Array.isArray(layout.pages),
    'Source-layout lineage mismatch',
  );
  return { ...files, metadata, layout, bindings: [], assetFiles: new Map() };
}
