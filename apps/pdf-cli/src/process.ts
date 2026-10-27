import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import type {
  LocalRun,
  ProcessOptions,
  ProcessDependencies,
  PythonRequest,
  PdfInspection,
} from './local-run.js';
import {
  sha256,
  verifyP0Run,
  verifyPreview,
  requireInput,
} from './verified-input.js';
import { adaptLegacyPreview } from './legacy-preview.js';
import { writeExclusive, writeProvenance } from './provenance.js';
import { pythonEnvironment, runPython } from './python-runner.js';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function katexDirectory(explicit?: string): Promise<string> {
  const parent = join(repo, 'data/pdf-p0/render-deps');
  const candidates = explicit
    ? [resolve(explicit)]
    : await readdir(parent)
        .then((items) => items.map((item) => join(parent, item, 'package')))
        .catch(() => []);
  for (const path of candidates)
    try {
      const pkg = JSON.parse(
        await readFile(join(path, 'package.json'), 'utf8'),
      );
      const integrity = JSON.parse(
        await readFile(join(path, '../integrity.json'), 'utf8'),
      );
      if (
        pkg.name === 'katex' &&
        pkg.version === '0.19.0' &&
        integrity.package === 'katex' &&
        integrity.version === '0.19.0' &&
        typeof integrity.integrity === 'string' &&
        integrity.integrity.startsWith('sha512-')
      )
        return path;
    } catch {
      /* try next prepared directory */
    }
  throw new Error(
    'Prepared KaTeX 0.19.0 missing. Run: python benchmarks/pdf/tools/prepare-preview-renderer.py --output data/pdf-p0/render-deps/katex-0.19.0',
  );
}
export async function processPdf(
  options: ProcessOptions,
  deps: ProcessDependencies = {},
): Promise<LocalRun> {
  const root = resolve(options.runDir);
  const source = resolve(options.sourcePath);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  process.once('SIGINT', abort);
  const state: LocalRun = {
    schemaVersion: 'pagelingo-local-run/1',
    workflowId: randomUUID(),
    status: 'processing',
    sourceSha256: '',
    translationStatus: 'pending',
    stage: 'source',
    exportReady: false,
    exportBlockers: [],
    paths: {
      source: 'source.pdf',
      ir: 'source-ir.json',
      provenance: 'provenance',
      assets: 'assets',
      inspection: 'inspection.json',
      parser: options.p0RunDir ? null : 'parser',
      preview: options.previewDir ? null : 'preview',
    },
  };
  const checkpoint = async () => {
    await writeFile(join(root, 'config.json.tmp'), serializeBundleJson(state), {
      mode: 0o600,
    });
    await rename(join(root, 'config.json.tmp'), join(root, 'config.json'));
  };
  const python =
    options.pythonPath ??
    join(repo, 'services/document-parser/.venv-mineru/bin/python');
  const request = (args: string[]): PythonRequest => ({
    executable: python,
    args,
    cwd: repo,
    env: pythonEnvironment(python, repo),
    signal: controller.signal,
  });
  const execute = deps.runPython ?? runPython;
  try {
    controller.signal.throwIfAborted();
    const bytes = await readFile(source);
    requireInput(
      bytes.subarray(0, 5).toString() === '%PDF-',
      'Source is not a PDF',
    );
    requireInput(bytes.length <= 256 * 1024 * 1024, 'PDF exceeds 256 MiB');
    state.sourceSha256 = sha256(bytes);
    await writeExclusive(root, state.paths.source, bytes);
    await checkpoint();
    state.stage = 'parser';
    await checkpoint();
    let p0 = options.p0RunDir;
    if (!p0) {
      p0 = join(root, 'parser');
      requireInput(
        options.modelDir,
        'Prepared MinerU model directory is required; run the existing PDF setup separately',
      );
      await execute(
        request([
          '-m',
          'pagelingo_parser',
          'parse',
          join(root, state.paths.source),
          '--parser',
          'mineru',
          '--output',
          p0,
          '--model-dir',
          resolve(options.modelDir),
          '--pages',
          options.pages ?? 'all',
        ]),
      );
    }
    // Exit status is not a completeness signal: the verified run.json decides whether partial is usable.
    controller.signal.throwIfAborted();
    const run = await verifyP0Run(p0, state.sourceSha256);
    state.stage = 'preview';
    await checkpoint();
    let previewRoot = options.previewDir;
    if (!previewRoot) {
      previewRoot = join(root, 'preview');
      const katex = await katexDirectory(options.katexDir);
      const result = await execute(
        request([
          join(repo, 'benchmarks/pdf/tools/export-mineru-preview.py'),
          resolve(p0),
          '--output',
          previewRoot,
          '--katex',
          katex,
          '--archive',
          join(root, 'legacy-preview.zip'),
        ]),
      );
      requireInput(result.exitCode === 0, 'Legacy preview export failed');
    }
    const preview = await verifyPreview(previewRoot, run);
    state.stage = 'inspection';
    await checkpoint();
    const inspectRequest = request([
      join(repo, 'apps/pdf-cli/python/reader_inspection.py'),
      join(root, state.paths.source),
    ]);
    const inspection: PdfInspection = deps.inspectPdf
      ? await deps.inspectPdf(join(root, state.paths.source), inspectRequest)
      : await execute(inspectRequest).then((result) => {
          requireInput(result.exitCode === 0, 'PDF inspection failed');
          return JSON.parse(result.stdout) as PdfInspection;
        });
    await writeExclusive(
      root,
      state.paths.inspection,
      serializeBundleJson(inspection),
    );
    state.stage = 'projection';
    await checkpoint();
    const ir = await adaptLegacyPreview({ run, preview, inspection });
    controller.signal.throwIfAborted();
    const evidence = await writeProvenance(root, run, preview);
    const irBytes = serializeBundleJson(ir);
    await writeExclusive(root, state.paths.ir, irBytes);
    // Revalidate every original manifest member after projection/copy; changed inputs cannot publish a successful local run.
    const finalRun = await verifyP0Run(p0, state.sourceSha256);
    const finalPreview = await verifyPreview(previewRoot, run);
    requireInput(
      sha256(finalRun.manifestBytes) === sha256(run.manifestBytes) &&
        sha256(finalPreview.manifestBytes) === sha256(preview.manifestBytes),
      'Input manifest bytes changed during processing',
    );
    requireInput(
      sha256(await readFile(source)) === state.sourceSha256,
      'Original source hash changed during processing',
    );
    state.readerIrSha256 = sha256(irBytes);
    state.configSha256 = ir.parse.configSha256;
    state.parseId = ir.parse.id;
    state.translationStatus = ir.blocks
      .filter((b) => b.type === 'text')
      .every(
        (b) =>
          b.language.language === 'zh' || b.language.reason === 'no-language',
      )
      ? 'not-required'
      : 'pending';
    state.exportBlockers = evidence.blockers;
    state.exportReady = evidence.blockers.length === 0;
    state.status = ir.parse.status;
    state.stage = 'ready';
    await checkpoint();
    return state;
  } catch (error) {
    state.status = controller.signal.aborted ? 'cancelled' : 'failed';
    state.failure = controller.signal.aborted
      ? 'Local processing cancelled'
      : error instanceof Error
        ? error.message
        : 'Local processing failed';
    await checkpoint();
    throw error;
  } finally {
    process.removeListener('SIGINT', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
/** Resolve only local-run-owned relative stage paths. */
export function localStagePath(runDir: string, path: string): string {
  const target = resolve(runDir, path);
  requireInput(
    !relative(resolve(runDir), target).startsWith('..') &&
      !path.startsWith('/'),
    'Invalid stage path',
  );
  return target;
}
