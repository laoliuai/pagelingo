import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryFileSource, deriveParseId, writeBundle } from '@pagelingo/document-bundle';
import { defaultBundleLimits, type DocumentBundleManifest, type ReaderIR, type ReaderTranslation } from '@pagelingo/document-contracts';
import { planUnits } from '@pagelingo/translation-core';
import { toTranslationDocument } from '@pagelingo/document-renderer';
import { fixture, json, refresh } from '../../../../packages/document-bundle/tests/fixtures.js';

export async function bundleFixture(root: string, options: {
  status?: 'pending' | 'partial' | 'completed' | 'failed'; partialParse?: boolean; packageId?: string; translationId?: string;
  edit?: (files: Map<string, Buffer>) => void;
} = {}) {
  const files = await fixture(options.status === 'partial' ? 'partial' : 'pending');
  const ir: ReaderIR = JSON.parse(files.get('source-ir.json')!.toString());
  const translation: ReaderTranslation = JSON.parse(files.get('translation.json')!.toString());
  const manifest: DocumentBundleManifest = JSON.parse(files.get('manifest.json')!.toString());
  if (options.partialParse) {
    ir.parse.status = 'partial'; ir.parse.coverage = 'partial'; ir.parse.projectorVersion += '-partial';
    ir.parse.id = deriveParseId(ir.source.sha256, ir.parse.inputManifestSha256, ir.parse.projectorVersion, ir.parse.configSha256);
    translation.parseId = ir.parse.id;
    manifest.parse = { ...manifest.parse, id: ir.parse.id, projectorVersion: ir.parse.projectorVersion };
    files.set('source-ir.json', json(ir));
  }
  translation.id = options.translationId ?? randomUUID();
  if (options.status === 'completed') {
    const plan = planUnits(toTranslationDocument(ir, translation.selectionBlockIds), translation.targetLanguage, translation.profile, translation.budget, translation);
    translation.blocks = plan.inputs.map(input => ({ blockId: input.id, status: 'translated', rawText: input.protectedText }));
    translation.units = translation.units.map(unit => ({ ...unit, status: 'covered-by-block' }));
    translation.status = 'completed'; translation.generationKind = 'mock';
  } else if (options.status === 'failed') {
    translation.blocks = translation.blocks.map(block => ({ blockId: block.blockId, status: 'source-only', reason: 'failed' }));
    translation.units = translation.units.map(unit => ({ ...unit, status: 'failed' }));
    translation.status = 'failed';
  }
  manifest.packageId = options.packageId ?? randomUUID();
  manifest.translation = { ...manifest.translation, id: translation.id, status: translation.status, generationKind: translation.generationKind };
  files.set('translation.json', json(translation)); files.set('manifest.json', json(manifest));
  options.edit?.(files); refresh(files);
  const path = join(root, randomUUID() + '.zip');
  await writeBundle(createMemoryFileSource(files, defaultBundleLimits), path, { limits: defaultBundleLimits });
  return { bytes: await readFile(path), files, manifest: JSON.parse(files.get('manifest.json')!.toString()) as DocumentBundleManifest };
}
export async function* body(bytes: Uint8Array) { yield bytes; }
