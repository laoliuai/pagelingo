// Explicit local acceptance only. Never reads dotenv, installs models or calls an API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--mock-translation') options.mockTranslation = true;
    else if (['--corpus', '--runs-root', '--output'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${key}`);
  }
  if (!options.corpus || !options['runs-root'] || !options.output) throw new Error('Required: --corpus <corpus.json> --runs-root <runs> --output <new-output> [--mock-translation]');
  return options;
}
const fakeKey = 'FAKE_PAGELINGO_ACCEPTANCE_KEY_NEVER_EXPORT_572719';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async path => hash(await readFile(path));
const count = (items, key) => Object.fromEntries([...new Set(items.map(item => item[key]))].map(value => [value, items.filter(item => item[key] === value).length]));

export async function checkPdfReader(options) {
  const corpusPath = resolve(options.corpus);
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  assert(Array.isArray(corpus.samples) && corpus.samples.length, 'Corpus must select at least one sample');
  const runsRoot = await realpath(resolve(options['runs-root']));
  const requestedOutput = resolve(options.output);
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  const inputs = []; const identities = new Set();
  for (const sample of corpus.samples) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(sample.id) && !identities.has(sample.id), 'Unique safe sample id required'); identities.add(sample.id);
    assert(Number.isSafeInteger(sample.pageCount) && sample.pageCount > 0 && /^[a-f0-9]{64}$/.test(sample.sha256), 'Expected pageCount and SHA-256 required');
    const source = await realpath(resolve(dirname(corpusPath), sample.path));
    const p0 = await realpath(resolve(runsRoot, sample.reader?.p0Run ?? sample.id));
    const preview = sample.reader?.preview ? await realpath(resolve(dirname(corpusPath), sample.reader.preview)) : undefined;
    assert(sample.reader?.python, 'Explicit prepared reader.python interpreter required; no automatic environment setup');
    assert(preview || sample.reader?.katex, 'Explicit reader.preview or prepared reader.katex required');
    for (const input of [source, p0, preview].filter(Boolean)) {
      const path = relative(input, output);
      assert(path !== '' && (path === '..' || path.startsWith('../') || isAbsolute(path)), 'Output must be outside original inputs');
    }
    assert.equal(await fileHash(source), sample.sha256, `${sample.id}: original PDF hash`);
    const manifests = [join(p0, 'manifest.json'), ...(preview ? [join(preview, 'manifest.json')] : [])];
    const before = await Promise.all(manifests.map(async path => ({ path, sha256: await fileHash(path) })));
    inputs.push({ sample, source, p0, preview, before });
  }
  await mkdir(output, { recursive: false, mode: 0o700 });
  const { processPdf, translateRun, exportBundle } = await import('../apps/pdf-cli/dist/index.js');
  const { defaultBundleLimits } = await import('@pagelingo/document-contracts');
  const { createArchiveFileSource, validateBundle, readArchive } = await import('@pagelingo/document-bundle');
  const { verifyOffline } = await import('./pdf-reader-offline.mjs');
  const report = { schemaVersion: 'pagelingo-reader-acceptance/1', generationKind: options.mockTranslation ? 'mock' : 'none', semanticTranslationQuality: 'not-verified', limits: defaultBundleLimits, samples: [], status: 'running' };
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    for (const { sample, source, p0, preview, before } of inputs) {
      const start = performance.now();
      const root = join(output, sample.id); await mkdir(root);
      const runDir = join(root, 'run');
      console.log(`${sample.id}: projecting ${sample.pageCount} pages from explicit local inputs`);
      await processPdf({ sourcePath: source, runDir, p0RunDir: p0, previewDir: preview, pythonPath: sample.reader.python, katexDir: sample.reader.katex });
      const ir = JSON.parse(await readFile(join(runDir, 'source-ir.json'), 'utf8'));
      assert.equal(ir.pages.length, sample.pageCount); assert.deepEqual(ir.pages.map(page => page.pageIndex), Array.from({ length: sample.pageCount }, (_, i) => i));
      assert.equal(ir.parse.coverage, 'full');
      const previewRoot = preview ?? join(runDir, 'preview');
      const previewMetadata = JSON.parse(await readFile(join(previewRoot, 'preview.json'), 'utf8'));
      const previewManifest = JSON.parse(await readFile(join(previewRoot, 'manifest.json'), 'utf8'));
      const originalImages = previewMetadata.originalVisuals.map(image => {
        const entry = previewManifest.files.find(file => file.path === image.path);
        assert(entry, 'original visual is listed');
        assert(ir.assets.some(asset => asset.sha256 === entry.sha256 && asset.bytes === entry.bytes), 'original visual bytes retained');
        return { path: image.path, sha256: entry.sha256, kind: image.kind, role: image.role };
      });
      let recovery = null;
      if (options.mockTranslation) {
        const echo = request => ({ translations: request.data.blocks.map(block => ({ id: block.id, text: block.protectedText })) });
        const config = { runDir, selection: 'auto', provider: { baseUrl: 'http://localhost:1/v1', model: 'acceptance-echo-mock' }, resume: false, newJob: false };
        const controller = new AbortController(); let calls = 0; const completedRequestIds = new Set();
        const partial = await translateRun(config, { generationKind: 'mock', signal: controller.signal, provider: { generate: async request => { if (++calls === 2) controller.abort(); else if (calls === 1) for (const block of request.data.blocks) completedRequestIds.add(block.id); return echo(request); } } });
        const immutable = await fileHash(join(runDir, partial.snapshotPath));
        assert.equal(partial.snapshot.status, 'partial', 'interruption retains partial result');
        let resumedRequests = 0;
        const resumed = await translateRun({ ...config, resume: true }, { generationKind: 'mock', provider: { generate: async request => { resumedRequests++; assert(request.data.blocks.every(block => !completedRequestIds.has(block.id)), 'resume does not request completed units'); return echo(request); } } });
        assert.equal(await fileHash(join(runDir, partial.snapshotPath)), immutable);
        assert.equal(resumed.snapshot.generationKind, 'mock');
        assert(resumed.snapshot.units.every(unit => ['completed', 'covered-by-block'].includes(unit.status)), 'all selected translation units recover');
        recovery = { interruptedStatus: partial.snapshot.status, resumedStatus: resumed.snapshot.status, immutableSnapshotSha256: immutable, resumedRequests, completedUnitsNotRequested: true, completedBlocks: resumed.snapshot.blocks.filter(block => block.status === 'translated').length };
      }
      const archivePath = join(root, 'reader.zip');
      await exportBundle({ runDir, outputDir: join(root, 'bundle'), archivePath });
      const validated = await validateBundle(createArchiveFileSource(archivePath, defaultBundleLimits), { limits: defaultBundleLimits });
      assert.equal(validated.ir.source.sha256, sample.sha256);
      // Unpack only the full validator's verified membership into a new directory.
      const unpacked = join(root, 'unpacked'); await mkdir(unpacked);
      const allowed = new Set(['manifest.json', ...validated.files.map(file => file.path)]);
      for await (const entry of readArchive(archivePath, defaultBundleLimits)) {
        assert(allowed.has(entry.path)); const destination = join(unpacked, entry.path);
        await mkdir(dirname(destination), { recursive: true });
        const parts = []; for await (const part of entry.content) parts.push(part);
        await writeFile(destination, Buffer.concat(parts), { flag: 'wx' });
      }
      assert.equal(await fileHash(join(unpacked, 'source.pdf')), sample.sha256);
      for (const file of validated.files) {
        const bytes = await readFile(join(unpacked, file.path));
        for (const forbidden of [fakeKey, runsRoot, dirname(source), sample.reader.python, previewRoot, runDir]) assert(!bytes.includes(Buffer.from(forbidden)), `known runtime path/key leaked in ${file.path}`);
      }
      const offline = await verifyOffline(unpacked, validated, join(root, 'screenshots'));
      const after = await Promise.all(before.map(async entry => ({ path: entry.path, sha256: await fileHash(entry.path) })));
      assert.deepEqual(after, before); assert.equal(await fileHash(source), sample.sha256);
      const files = validated.files;
      report.samples.push({ id: sample.id, pages: ir.pages.length, sourceSha256: sample.sha256, manifestSha256: validated.manifestSha256, archiveSha256: await fileHash(archivePath), readerIrSha256: validated.manifest.readerIrSha256, translationSha256: validated.manifest.translation.sha256, renderer: validated.manifest.renderer, originalManifestsBefore: before, originalManifestsAfter: after, parseCoverage: ir.parse.coverage, translationStatus: validated.translation.status, translationBlockStatuses: count(validated.translation.blocks, 'status'), translationUnitStatuses: count(validated.translation.units, 'status'), warnings: ir.warnings, blockTypes: count(ir.blocks, 'type'), nodeTypes: count(ir.nodes, 'kind'), originalVisualsPreserved: originalImages, knownRuntimePathAndFakeKeyScan: 'passed (explicit input paths and fixed sentinel only; not arbitrary secret detection)', images: ir.assets.map(asset => ({ path: asset.path, sha256: asset.sha256 })), sourceRefs: count(ir.blocks.flatMap(block => block.sourceRefs), 'precision'), recovery, offline, budget: { zipBytes: (await stat(archivePath)).size, expandedBytes: files.reduce((sum, file) => sum + file.bytes, 0) + (await stat(join(unpacked, 'manifest.json'))).size, files: files.length + 1, irBytes: files.find(file => file.path === 'source-ir.json').bytes, translationBytes: files.find(file => file.path === 'translation.json').bytes, chunks: validated.readerBuild.chunks.length, largestChunkBytes: Math.max(...validated.readerBuild.chunks.map(chunk => Buffer.byteLength(JSON.stringify(chunk)))) }, elapsedSeconds: Math.round((performance.now() - start) / 1000) });
      await save(); console.log(`${sample.id}: full hash/IR/translation/resource/offline checks passed (${offline.chunksVisited} chunks)`);
    }
    report.status = 'passed'; await save(); console.log(`Acceptance passed: ${report.samples.length} samples; semantic translation quality NOT verified`);
    return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; await save(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await checkPdfReader(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
