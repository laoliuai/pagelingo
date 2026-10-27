import { crc32 } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  BundleFile,
  DocumentBundleManifest,
  ReaderIR,
  ReaderTranslation,
} from '@pagelingo/document-contracts';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import {
  contentHash,
  stableJson,
  planUnits,
  PROMPT_VERSION,
  PROTECTION_VERSION,
} from '@pagelingo/translation-core';
import {
  buildReader,
  createStaticFilePlan,
  toTranslationDocument,
} from '@pagelingo/document-renderer';
import { createRequire } from 'node:module';
export const hash = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');
export const json = (value: unknown): Buffer => Buffer.from(stableJson(value));
export const limits = defaultBundleLimits;
const require = createRequire(import.meta.url);
export async function fixture(
  kind: 'pending' | 'chinese' | 'partial' = 'pending',
): Promise<Map<string, Buffer>> {
  const ir: ReaderIR = JSON.parse(
    await readFile(
      new URL(
        '../../document-contracts/fixtures/reader-v1/source-ir.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const translation: ReaderTranslation = JSON.parse(
    await readFile(
      new URL(
        '../../document-contracts/fixtures/reader-v1/translation.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const files = new Map<string, Buffer>();
  files.set('source.pdf', Buffer.from('%PDF-1.7\nfixture original\n%%EOF\n'));
  files.set(
    'provenance/input-manifest.json',
    json({ schema_version: 'parser-run/1', files: [] }),
  );
  files.set(
    'provenance/parser-config.json',
    json({
      schemaVersion: 'pagelingo-parser-config/1',
      parser: { name: 'fixture', version: null },
      options: { tier: 'basic' },
    }),
  );
  ir.source.bytes = files.get('source.pdf')!.length;
  ir.source.sha256 = hash(files.get('source.pdf')!);
  ir.parse.inputManifestSha256 = hash(
    files.get('provenance/input-manifest.json')!,
  );
  ir.parse.configSha256 = hash(files.get('provenance/parser-config.json')!);
  ir.parse.id =
    'p_' +
    hash(
      ir.source.sha256 +
        ir.parse.inputManifestSha256 +
        ir.parse.projectorVersion +
        ir.parse.configSha256,
    );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9s8AAAAASUVORK5CYII=',
    'base64',
  );
  png.writeUInt32BE(crc32(png.subarray(37, 52)), 52);
  files.set(ir.assets[0].path, png);
  Object.assign(ir.assets[0], {
    sha256: hash(png),
    bytes: png.length,
    width: 1,
    height: 1,
  });
  if (kind === 'chinese') {
    ir.metadata.language = { language: 'zh', reason: 'han-only' };
    for (const b of ir.blocks)
      if (b.type === 'text') {
        b.value.content = [{ type: 'text', text: '这是一份中文文档。' }];
        b.bindings = [];
        b.language = { language: 'zh', reason: 'han-only' };
      }
  }
  files.set('source-ir.json', json(ir));
  Object.assign(translation, {
    sourceSha256: ir.source.sha256,
    parseId: ir.parse.id,
    readerIrSha256: hash(files.get('source-ir.json')!),
    promptVersion: PROMPT_VERSION,
    protectionVersion: PROTECTION_VERSION,
    glossarySha256: await contentHash(translation.glossary),
  });
  translation.selectionBlockIds =
    kind === 'chinese'
      ? []
      : ir.blocks.filter((b) => b.type === 'text').map((b) => b.id);
  const plan = planUnits(
    toTranslationDocument(ir, translation.selectionBlockIds),
    translation.targetLanguage,
    translation.profile,
    translation.budget,
    translation,
  );
  translation.units = plan.units.map((u) => ({
    id: u.id,
    part: u.part,
    blockId: plan.inputs[u.blockIndex].id,
    status:
      kind === 'partial' && u.blockIndex === 0 ? 'covered-by-block' : 'pending',
  }));
  translation.blocks = ir.blocks
    .filter((b) => b.type === 'text')
    .map((b) =>
      kind === 'partial' && b.id === plan.inputs[0].id
        ? {
            blockId: b.id,
            status: 'translated',
            rawText: plan.inputs[0].protectedText,
          }
        : {
            blockId: b.id,
            status: 'source-only',
            reason: kind === 'chinese' ? 'language-not-required' : 'pending',
          },
    );
  translation.status =
    kind === 'chinese'
      ? 'not-required'
      : kind === 'partial'
        ? 'partial'
        : 'pending';
  translation.generationKind = kind === 'partial' ? 'mock' : 'none';
  files.set('translation.json', json(translation));
  const staticPlan = createStaticFilePlan(buildReader(ir, translation), {
    title: ir.metadata.title,
    originalFilename: ir.metadata.originalFilename,
  });
  for (const asset of staticPlan.trustedAssets) {
    const root = dirname(
      require.resolve(asset.source.package + '/package.json'),
    );
    files.set(asset.path, await readFile(join(root, asset.source.path)));
  }
  for (const generated of staticPlan.generatedFiles)
    files.set(generated.path, Buffer.from(generated.content));
  const manifest: DocumentBundleManifest = {
    schemaVersion: 'pagelingo-document-bundle/1',
    packageId: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-10-27T00:00:00Z',
    title: ir.metadata.title,
    originalFilename: ir.metadata.originalFilename,
    source: ir.source,
    parse: {
      id: ir.parse.id,
      inputManifestSha256: ir.parse.inputManifestSha256,
      configSha256: ir.parse.configSha256,
      projectorVersion: ir.parse.projectorVersion,
    },
    readerIrSha256: hash(files.get('source-ir.json')!),
    translation: {
      id: translation.id,
      sha256: hash(files.get('translation.json')!),
      status: translation.status,
      generationKind: translation.generationKind,
    },
    renderer: {
      version: staticPlan.rendererVersion,
      codeSha256: staticPlan.rendererSha256,
    },
    files: [],
  };
  manifest.files = [...files].map(([path, body]) => ({
    path,
    bytes: body.length,
    sha256: hash(body),
    ...fileType(path),
  }));
  files.set('manifest.json', json(manifest));
  return files;
}
function fileType(path: string): Pick<BundleFile, 'role' | 'mediaType'> {
  if (path === 'source.pdf')
    return { role: 'source', mediaType: 'application/pdf' };
  if (path === 'source-ir.json')
    return { role: 'reader-ir', mediaType: 'application/json' };
  if (path === 'translation.json')
    return { role: 'translation', mediaType: 'application/json' };
  if (path.startsWith('provenance/'))
    return { role: 'provenance', mediaType: 'application/json' };
  if (path.startsWith('licenses/'))
    return { role: 'license', mediaType: 'text/plain' };
  return {
    role: path.startsWith('render/') ? 'render' : 'asset',
    mediaType: path.endsWith('.png')
      ? 'image/png'
      : path.endsWith('.html')
        ? 'text/html'
        : path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.woff2')
              ? 'font/woff2'
              : path.endsWith('.woff')
                ? 'font/woff'
                : 'font/ttf',
  };
}
export function updateManifest(files: Map<string, Buffer>): void {
  const m: DocumentBundleManifest = JSON.parse(
    files.get('manifest.json')!.toString(),
  );
  for (const f of m.files) {
    const body = files.get(f.path);
    if (body) {
      f.bytes = body.length;
      f.sha256 = hash(body);
    }
  }
  files.set('manifest.json', json(m));
}
export async function directory(
  root: string,
  files: Map<string, Buffer>,
): Promise<void> {
  for (const [path, body] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
}

/** Rebuild all cross-file identities/static bytes after a deliberate semantic fixture edit. */
export function refresh(files: Map<string, Buffer>): void {
  const ir: ReaderIR = JSON.parse(files.get('source-ir.json')!.toString());
  const translation: ReaderTranslation = JSON.parse(
    files.get('translation.json')!.toString(),
  );
  const manifest: DocumentBundleManifest = JSON.parse(
    files.get('manifest.json')!.toString(),
  );
  translation.readerIrSha256 = hash(files.get('source-ir.json')!);
  files.set('translation.json', json(translation));
  Object.assign(manifest, {
    title: ir.metadata.title,
    originalFilename: ir.metadata.originalFilename,
    readerIrSha256: translation.readerIrSha256,
  });
  manifest.translation.sha256 = hash(files.get('translation.json')!);
  const plan = createStaticFilePlan(buildReader(ir, translation), {
    title: ir.metadata.title,
    originalFilename: ir.metadata.originalFilename,
  });
  for (const generated of plan.generatedFiles)
    files.set(generated.path, Buffer.from(generated.content));
  files.set('manifest.json', json(manifest));
  updateManifest(files);
}
