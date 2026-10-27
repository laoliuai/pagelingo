import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { contentHash } from '@pagelingo/translation-core';
import {
  readerIrSchema,
  readerTranslationSchema,
  validateReaderGraph,
  type ReaderIR,
  type ReaderTranslation,
} from '@pagelingo/document-contracts';
import { buildReader } from '@pagelingo/document-renderer';
import { aborted, check, sanitize } from './errors.js';
import {
  checkedLimits,
  checkSize,
  fileLimit,
  parseBoundedJson,
} from './limits.js';
import { parseParserConfig, type ParserConfig } from './parser-config.js';
import { PathRegistry } from './paths.js';
import { admitManifest } from './manifest.js';
import { digestFile } from './file-reader.js';
import { inspectImage, type ImageMetadata } from './images.js';
import { checkIdentities, checkReaderLimits } from './resource-closure.js';
import { validateStaticFiles } from './static-assets.js';
import type {
  BundleFileSource,
  BundleOptions,
  ValidatedBundle,
} from './types.js';

/** Frozen five-minute validation deadline, also checked around synchronous work. */
export const validationDeadlineMs = 300000;
export async function validateBundle(
  input: BundleFileSource,
  options: BundleOptions,
): Promise<ValidatedBundle> {
  const { signal } = options,
    started = performance.now();
  const checkpoint = async (): Promise<void> => {
    await setImmediate();
    aborted(signal);
    check(
      performance.now() - started <= validationDeadlineMs,
      'BUNDLE_TOO_LARGE',
    );
  };
  try {
    const limits = checkedLimits(options.limits);
    await checkpoint();
    const listed = await input.list();
    await checkpoint();
    check(Array.isArray(listed));
    checkSize(listed.length, limits.maxFiles);
    const paths = new PathRegistry(limits.maxPathBytes);
    let declared = 0;
    for (const info of listed) {
      check(info && typeof info.path === 'string');
      paths.add(info.path);
      checkSize(info.bytes, fileLimit(info.path, limits));
      declared += info.bytes;
      checkSize(declared, limits.maxExpandedBytes);
    }
    const manifestInfo = listed.find((f) => f.path === 'manifest.json');
    check(manifestInfo, 'BUNDLE_MISSING_RESOURCE');
    let expanded = 0;
    const account = (n: number): void => {
      expanded += n;
      checkSize(expanded, limits.maxExpandedBytes);
      aborted(signal);
      check(
        performance.now() - started <= validationDeadlineMs,
        'BUNDLE_TOO_LARGE',
      );
    };
    const manifestBody = await digestFile(
      input,
      manifestInfo,
      limits,
      account,
      true,
      signal,
    );
    const manifest = admitManifest(
      parseBoundedJson(manifestBody.body!, limits.maxJsonDepth),
      listed,
      limits,
    );
    let ir: ReaderIR | undefined,
      translation: ReaderTranslation | undefined,
      parserConfig: ParserConfig | undefined;
    const images = new Map<string, ImageMetadata>();
    for (const file of manifest.files) {
      await checkpoint();
      const jsonFile = [
        'source-ir.json',
        'translation.json',
        'provenance/input-manifest.json',
        'provenance/parser-config.json',
      ].includes(file.path);
      const image =
        file.role === 'asset' && file.mediaType.startsWith('image/');
      const actual = await digestFile(
        input,
        file,
        limits,
        account,
        jsonFile || image,
        signal,
      );
      check(actual.sha256 === file.sha256);
      if (file.path === 'source.pdf')
        check(actual.prefix.includes(Buffer.from('%PDF-')));
      if (jsonFile) {
        const value = parseBoundedJson(actual.body!, limits.maxJsonDepth);
        if (file.path === 'source-ir.json') {
          const candidate = value as ReaderIR;
          check(candidate && typeof candidate === 'object');
          if (Array.isArray(candidate.nodes))
            checkSize(candidate.nodes.length, limits.maxNodes);
          if (Array.isArray(candidate.blocks))
            checkSize(candidate.blocks.length, limits.maxBlocks);
          ir = readerIrSchema.parse(value);
        } else if (file.path === 'translation.json')
          translation = readerTranslationSchema.parse(value);
        else {
          check(value && typeof value === 'object' && !Array.isArray(value));
          if (file.path.endsWith('parser-config.json'))
            parserConfig = parseParserConfig(value);
        }
      }
      if (image) {
        const metadata = inspectImage(actual.body!);
        checkSize(metadata.width, limits.maxImageDimension);
        checkSize(metadata.height, limits.maxImageDimension);
        checkSize(metadata.width * metadata.height, limits.maxImagePixels);
        images.set(file.path, metadata);
      }
    }
    check(ir && translation && parserConfig, 'BUNDLE_MISSING_RESOURCE');
    check(
      parserConfig.parser.name === ir.parse.parserName &&
        parserConfig.parser.version === ir.parse.parserVersion,
    );
    checkIdentities(manifest, ir, translation);
    checkReaderLimits(ir, translation, limits);
    validateReaderGraph(ir);
    check(
      (await contentHash(translation.glossary)) === translation.glossarySha256,
    );
    for (const asset of ir.assets) {
      const actual = images.get(asset.path);
      check(actual, 'BUNDLE_MISSING_RESOURCE');
      check(
        actual.mediaType === asset.mediaType &&
          actual.width === asset.width &&
          actual.height === asset.height,
      );
    }
    await checkpoint();
    const readerBuild = buildReader(ir, translation);
    await checkpoint();
    const allowed = await validateStaticFiles(
      manifest,
      readerBuild,
      limits,
      checkpoint,
    );
    for (const asset of ir.assets) {
      check(!allowed.has(asset.path));
      allowed.add(asset.path);
    }
    for (const file of manifest.files) {
      if (
        ['source.pdf', 'source-ir.json', 'translation.json'].includes(file.path)
      )
        continue;
      if (file.path.startsWith('provenance/')) {
        check(file.role === 'provenance');
        continue;
      }
      check(allowed.has(file.path));
    }
    await checkpoint();
    const manifestSha256 = await contentHash(manifest);
    await checkpoint();
    return {
      packageId: manifest.packageId,
      manifestSha256,
      manifest,
      ir,
      translation,
      readerBuild,
      files: manifest.files,
    };
  } catch (error) {
    throw sanitize(error, signal);
  }
}
