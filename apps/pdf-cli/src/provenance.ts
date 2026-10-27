import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import type { VerifiedP0Run, VerifiedPreview } from './local-run.js';
import { readVerified, sha256, requireInput } from './verified-input.js';
interface CopyRecord {
  originalPath: string;
  path: string;
  originalSha256: string;
  sha256: string;
  mode: 'original' | 'sanitized-copy';
  fields: { pointer: string; original: string; projected: string | null }[];
}
export async function writeExclusive(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
}
/** Only selected actual evidence is archived. Arbitrary logs, environment and request snapshots are excluded. */
export async function writeProvenance(
  root: string,
  run: VerifiedP0Run,
  preview: VerifiedPreview,
): Promise<{ blockers: string[] }> {
  const records: CopyRecord[] = [];
  const blockers: string[] = [];
  const copy = async (
    input: VerifiedP0Run | VerifiedPreview,
    originalPath: string,
    path: string,
    project?: unknown,
    fields: CopyRecord['fields'] = [],
  ) => {
    const original = await readVerified(input, originalPath);
    const bytes =
      project === undefined ? original : serializeBundleJson(project);
    await writeExclusive(root, path, bytes);
    records.push({
      originalPath,
      path,
      originalSha256: sha256(original),
      sha256: sha256(bytes),
      mode: project === undefined ? 'original' : 'sanitized-copy',
      fields,
    });
  };
  await writeExclusive(
    root,
    'provenance/input-manifest.json',
    run.manifestBytes,
  );
  await writeExclusive(
    root,
    'provenance/preview-manifest.json',
    preview.manifestBytes,
  );
  await writeExclusive(root, 'provenance/parser-config.json', run.configBytes);
  const metadata = structuredClone(run.metadata);
  const fields: CopyRecord['fields'] = [];
  // Known local paths are projected by field pointer, never by replacing text throughout JSON.
  if (typeof metadata.debug === 'string') {
    fields.push({
      pointer: '/debug',
      original: metadata.debug,
      projected: null,
    });
    delete metadata.debug;
  }
  const scan = (value: unknown, pointer: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const next = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (/(?:secret|credential|password|token|api.?key)/i.test(key))
        blockers.push(`unsupported-sensitive-field:${next}`);
      if (
        typeof item === 'string' &&
        /(?:path|dir|file|debug|output|input)/i.test(key) &&
        next !== '/input'
      )
        blockers.push(`unknown-run-path-field:${next}`);
      if (typeof item === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(item))
        blockers.push(`unknown-run-path-field:${next}`);
      if (item && typeof item === 'object') scan(item, next);
    }
  };
  scan(metadata, '');
  // A blocked metadata object is not copied into an exportable provenance directory.
  if (!blockers.length)
    await copy(run, 'run.json', 'provenance/run.json', metadata, fields);
  const raw = JSON.parse((await readVerified(run, 'raw.json')).toString());
  const rawFields: CopyRecord['fields'] = [];
  const assets = new Map<string, string>();
  const rewrite = async (value: unknown, pointer: string): Promise<void> => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const next = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (key === 'image_path' && typeof item === 'string') {
        const originalPath = `native/${item}`;
        if (!run.files.has(originalPath)) {
          blockers.push(`missing-raw-asset:${next}`);
          continue;
        }
        const entry = run.files.get(originalPath)!;
        const target = `provenance/raw-assets/${entry.sha256}.bin`;
        if (!assets.has(target)) {
          await copy(run, originalPath, target);
          assets.set(target, originalPath);
        }
        (value as Record<string, unknown>)[key] = target;
        rawFields.push({ pointer: next, original: item, projected: target });
      } else if (
        typeof item === 'string' &&
        /(?:path|directory|filename)$/i.test(key) &&
        key !== 'image_path'
      )
        blockers.push(`unknown-raw-path-field:${next}`);
      else if (item && typeof item === 'object') await rewrite(item, next);
    }
  };
  await rewrite(raw, '');
  await copy(
    run,
    'raw.json',
    'provenance/raw.json',
    rawFields.length ? raw : undefined,
    rawFields,
  );
  await copy(preview, 'source-layout.json', 'provenance/source-layout.json');
  const semanticMap: Record<string, string> = {};
  for (const [i, page] of preview.metadata.pages.entries()) {
    const target = `provenance/semantic/page-${String(i + 1).padStart(6, '0')}.html`;
    await copy(preview, page.path, target);
    semanticMap[page.path] = target;
  }
  const semantic = preview.bindings.map((binding) => ({
    ...binding,
    semanticFile: semanticMap[binding.semanticFile],
  }));
  await writeExclusive(
    root,
    'provenance/source-bindings.json',
    serializeBundleJson({
      schemaVersion: 'pagelingo-source-bindings/1',
      previewManifestSha256: sha256(preview.manifestBytes),
      bindings: semantic,
    }),
  );
  for (const [path, original] of preview.assetFiles)
    await copy(preview, original, path);
  for (const [path, key] of [
    ['model-lock.json', 'modelLockSha256'],
    ['python-lock.txt', 'pythonLockSha256'],
  ] as const) {
    if (run.files.has(path)) {
      const bytes = await readVerified(run, path);
      requireInput(sha256(bytes) === run.metadata[key], 'Lock hash mismatch');
      await copy(run, path, `provenance/${path}`);
    }
  }
  await writeExclusive(
    root,
    'provenance/copy-ledger.json',
    serializeBundleJson({
      schemaVersion: 'pagelingo-provenance-copies/1',
      records,
      exportBlockers: [...new Set(blockers)],
    }),
  );
  return { blockers: [...new Set(blockers)] };
}
