#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { processPdf } from './process.js';
import { readFile } from 'node:fs/promises';
import { CheckpointConflictError, parseGlossaryFile } from '@pagelingo/translation-core';
import { translateRun } from './translate.js';
import { LocalTranslationError } from './safe-config.js';
import { exportBundle, LocalExportError } from './bundle.js';
import { BundleError, createArchiveFileSource, validateBundle } from '@pagelingo/document-bundle';
import { defaultBundleLimits, bundleLimitsOverrideSchema, bundleLimitsSchema } from '@pagelingo/document-contracts';

const processGuidance = new Set([
  'Usage: pagelingo-pdf --source FILE --run-dir NEW_DIR [--p0-run DIR] [--preview DIR] [--python FILE] [--katex DIR] [--model-dir DIR] [--pages SELECTION]',
  'Prepared KaTeX 0.19.0 missing. Run: python benchmarks/pdf/tools/prepare-preview-renderer.py --output data/pdf-p0/render-deps/katex-0.19.0',
  'Prepared MinerU model directory is required; run the existing PDF setup separately',
  'Python process could not start; prepare the local parser environment',
]);
const translationCodes = new Set([
  'PROVIDER_CONFIG_INVALID', 'TRANSLATION_OPTIONS_INVALID', 'TRANSLATION_BUSY',
  'TRANSLATION_LOCK_UNAVAILABLE', 'TRANSLATION_PLATFORM_UNSUPPORTED', 'TRANSLATION_CONFIG_CHANGED',
  'TRANSLATION_IR_TOO_LARGE', 'TRANSLATION_JOB_EXISTS', 'TRANSLATION_JOB_MISSING',
  'TRANSLATION_RUN_NOT_READY', 'TRANSLATION_SDK_FAILED', 'TRANSLATION_SOURCE_CHANGED',
  'TRANSLATION_STATE_UNREADABLE', 'TRANSLATION_DISK_WRITE_FAILED', 'TRANSLATION_EPOCH_CONFLICT',
]);
function errorCode(error: unknown, translating: boolean): string {
  if (error instanceof BundleError || error instanceof LocalExportError) return error.code;
  if (error instanceof LocalTranslationError && translationCodes.has(error.code)) return error.code;
  if (error instanceof CheckpointConflictError && translationCodes.has(error.message)) return error.message;
  if (!translating && error instanceof Error && processGuidance.has(error.message)) return error.message;
  return 'PDF_CLI_FAILED';
}

async function translateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: {
    'run-dir': { type: 'string' }, run: { type: 'string' }, selection: { type: 'string', default: 'auto' },
    'source-language': { type: 'string' }, 'target-language': { type: 'string' }, profile: { type: 'string' },
    'base-url': { type: 'string' }, model: { type: 'string' }, 'api-key-env': { type: 'string' },
    resume: { type: 'boolean' }, 'new-job': { type: 'boolean' },
    'max-input-tokens': { type: 'string' }, 'max-output-tokens': { type: 'string' },
    'context-window-tokens': { type: 'string' }, 'max-batch-blocks': { type: 'string' }, 'reserve-tokens': { type: 'string' },
    'max-retries': { type: 'string' }, glossary: { type: 'string' },
  } });
  const runDir = values.run ?? values['run-dir'];
  if (!runDir || !values['base-url'] || !values.model || !['auto', 'all', 'none'].includes(values.selection!) || values.profile && !['technical', 'academic'].includes(values.profile)) throw new LocalTranslationError('TRANSLATION_OPTIONS_INVALID');
  const budget = Object.fromEntries([
    ['maxInputTokens', values['max-input-tokens']], ['maxOutputTokens', values['max-output-tokens']],
    ['contextWindowTokens', values['context-window-tokens']], ['maxBatchBlocks', values['max-batch-blocks']], ['reserveTokens', values['reserve-tokens']],
  ].filter(([, value]) => value !== undefined).map(([key, value]) => [key, Number(value)]));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await translateRun({ runDir, selection: values.selection as 'auto' | 'all' | 'none',
      provider: { baseUrl: values['base-url'], model: values.model, apiKeyEnv: values['api-key-env'] },
      sourceLanguage: values['source-language'], targetLanguage: values['target-language'], profile: values.profile as 'academic' | 'technical' | undefined,
      resume: values.resume ?? false, newJob: values['new-job'] ?? false, budget,
      maxRetries: values['max-retries'] === undefined ? undefined : Number(values['max-retries']),
      glossary: values.glossary ? parseGlossaryFile(await readFile(values.glossary, 'utf8'), 'json') : undefined,
    }, { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return controller.signal.aborted ? 130 : result.snapshot.status === 'failed' ? 1 : 0;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

async function bundleCommand(command: 'bundle' | 'verify', args: string[]): Promise<number> {
  const overrides = bundleLimitsOverrideSchema.parse(JSON.parse(process.env.PAGELINGO_BUNDLE_LIMITS_JSON ?? '{}'));
  const limits = bundleLimitsSchema.parse({ ...defaultBundleLimits, ...overrides,
    maxPdfBytes: process.env.PAGELINGO_MAX_PDF_BYTES === undefined ? defaultBundleLimits.maxPdfBytes : Number(process.env.PAGELINGO_MAX_PDF_BYTES),
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let identity: { packageId: string; manifestSha256: string };
    if (command === 'bundle') {
      const { values } = parseArgs({ args, options: { run: { type: 'string' }, 'run-dir': { type: 'string' }, output: { type: 'string' }, archive: { type: 'string' } } });
      const runDir = values.run ?? values['run-dir'];
      if (!runDir || !values.output || !values.archive) throw new LocalExportError('EXPORT_FAILED');
      identity = await exportBundle({ runDir, outputDir: values.output, archivePath: values.archive }, { limits, signal: controller.signal });
    } else {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      if (positionals.length !== 1) throw new LocalExportError('EXPORT_FAILED');
      const result = await validateBundle(createArchiveFileSource(positionals[0], limits, controller.signal), { limits, signal: controller.signal });
      identity = { packageId: result.packageId, manifestSha256: result.manifestSha256 };
    }
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return 0;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

export async function main(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    if (args[0] === 'translate') return await translateCommand(args.slice(1));
    if (args[0] === 'bundle' || args[0] === 'verify') return await bundleCommand(args[0], args.slice(1));
    const { values } = parseArgs({
      args: args[0] === 'process' ? args.slice(1) : args,
      options: {
        source: { type: 'string' },
        'run-dir': { type: 'string' },
        'p0-run': { type: 'string' },
        preview: { type: 'string' },
        python: { type: 'string' },
        katex: { type: 'string' },
        'katex-dir': { type: 'string' },
        'model-dir': { type: 'string' },
        pages: { type: 'string' },
      },
    });
    if (!values.source || !values['run-dir'])
      throw new Error(
        'Usage: pagelingo-pdf --source FILE --run-dir NEW_DIR [--p0-run DIR] [--preview DIR] [--python FILE] [--katex DIR] [--model-dir DIR] [--pages SELECTION]',
      );
    const result = await processPdf({
      sourcePath: values.source,
      runDir: values['run-dir'],
      p0RunDir: values['p0-run'],
      previewDir: values.preview,
      pythonPath: values.python,
      katexDir: values['katex-dir'] ?? values.katex,
      modelDir: values['model-dir'],
      pages: values.pages,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${errorCode(error, args[0] === 'translate')}\n`,
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  process.exitCode = await main();
