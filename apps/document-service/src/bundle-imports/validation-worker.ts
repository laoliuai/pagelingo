import { parentPort, workerData } from 'node:worker_threads';
import { createArchiveFileSource, serializeBundleJson, validateBundle, BundleError } from '@pagelingo/document-bundle';
import type { BundleLimits } from '@pagelingo/document-contracts';

// Only private archive location + public limits enter this worker. No actor, config or keys.
const { path, limits } = workerData as { path: string; limits: BundleLimits };
try {
  const valid = await validateBundle(createArchiveFileSource(path, limits), { limits });
  const generated = [
    { kind: 'index' as const, id: 'index', content: serializeBundleJson(valid.readerBuild.index) },
    ...valid.readerBuild.chunks.map(chunk => ({ kind: 'chunk' as const, id: chunk.id, content: serializeBundleJson(chunk) })),
  ];
  parentPort!.postMessage({ ok: true, value: {
    manifest: valid.manifest, manifestSha256: valid.manifestSha256,
    parseStatus: valid.ir.parse.status, parseCoverage: valid.ir.parse.coverage,
    warnings: valid.readerBuild.index.warnings, generated,
  } });
} catch (error) {
  parentPort!.postMessage({ ok: false, code: error instanceof BundleError ? error.code : 'INVALID_BUNDLE' });
}
