import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ZipFile } from 'yazl';
import { planUnits } from '@pagelingo/translation-core';
import { buildReader, createStaticFilePlan, toTranslationDocument } from '@pagelingo/document-renderer';
import { deriveParseId } from '@pagelingo/document-bundle';
import type { DocumentBundleManifest, ReaderIR, ReaderTranslation } from '@pagelingo/document-contracts';
import { fixture, hash, json } from '../../../../packages/document-bundle/tests/fixtures';

export const blockId = (i: number) => `b_${i.toString(16).padStart(32, '0')}`;
/** Owned synthetic PDF, independent from the app's overlay calculation. */
export function rotationPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 4 /Kids [3 0 R 5 0 R 7 0 R 9 0 R] >>'];
  for (let i = 0; i < 4; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /CropBox [20 40 380 460] /Rotate ${i * 90} /Resources << >> /Contents ${4 + i * 2} 0 R >>`);
    const content = '0.9 0.1 0.1 rg 60 100 80 100 re f\n';
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export async function readerBundle(large = false, mismatch = false, prefix = '译文 ') {
  const files = await fixture();
  const ir: ReaderIR = JSON.parse(files.get('source-ir.json')!.toString());
  const translation: ReaderTranslation = JSON.parse(files.get('translation.json')!.toString());
  const manifest: DocumentBundleManifest = JSON.parse(files.get('manifest.json')!.toString());
  const goldens = JSON.parse(await readFile(new URL('../../../../packages/document-contracts/fixtures/reader-v1/rotation-goldens.json', import.meta.url), 'utf8'));
  const pdf = rotationPdf(); files.set('source.pdf', pdf);
  ir.metadata.title = large ? 'Twenty thousand blocks' : 'Rotation reader';
  Object.assign(ir.source, { sha256: hash(pdf), bytes: pdf.length });
  ir.parse.id = deriveParseId(ir.source.sha256, ir.parse.inputManifestSha256, ir.parse.projectorVersion, ir.parse.configSha256);
  ir.blocks[0].sourceRefs = goldens.map((value: { pageIndex: number; bbox: number[] }) => ({ ...value, precision: 'bbox' }));
  for (const block of ir.blocks) if (block.type === 'code') block.code = 'const example = ' + 'wide_code_'.repeat(80);
  if (mismatch) ir.pages[1] = { ...ir.pages[0], pageIndex: 1 };
  if (large) {
    ir.metadata.language = { language: 'zh', reason: 'han-only' };
    for (const asset of ir.assets) files.delete(asset.path);
    ir.nodes = []; ir.blocks = []; ir.roots = []; ir.assets = [];
    let serial = 0;
    const nodeId = () => `n_${(++serial).toString(16).padStart(32, '0')}`;
    for (let start = 0; start < 20000; start += 64) {
      const section = { id: nodeId(), kind: 'section' as const, children: [] as string[], headingBlockId: blockId(start + 1) };
      const list = { id: nodeId(), kind: 'list' as const, ordered: true, start: start + 3, children: [] as string[] };
      ir.roots.push(section.id); ir.nodes.push(section, list);
      for (let i = start; i < Math.min(start + 64, 20000); i++) {
        const id = blockId(i + 1); const node = { id: nodeId(), kind: 'block' as const, children: [] as string[], blockId: id };
        ir.nodes.push(node);
        if (i === start) section.children.push(node.id, list.id);
        else { const item = { id: nodeId(), kind: 'list-item' as const, children: [node.id] }; ir.nodes.push(item); list.children.push(item.id); }
        ir.blocks.push({ id, type: 'text', sourceRefs: [{ pageIndex: Math.floor(i / 5000), precision: 'page' }], value: { id, kind: i === start ? 'heading' : 'paragraph', content: [{ type: 'text', text: `段落 ${i + 1} · 阅读内容保持顺序。` }] }, bindings: [], language: ir.metadata.language });
      }
    }
    // Keep the same reading order while making the first three chapters nested.
    const [a, b, c] = ir.roots.slice(0, 3).map(id => ir.nodes.find(node => node.id === id)!);
    a.children.push(b.id); b.children.push(c.id); ir.roots.splice(1, 2);
    for (const [i, title] of ['甲章', '乙节', '丙小节'].entries()) {
      const heading = ir.blocks[i * 64];
      if (heading.type === 'text') heading.value.content = [{ type: 'text', text: title }];
    }
  }
  Object.assign(translation, { id: randomUUID(), sourceSha256: ir.source.sha256, parseId: ir.parse.id, selectionBlockIds: large ? [] : ir.blocks.filter(b => b.type === 'text').map(b => b.id), status: large ? 'not-required' : 'completed', generationKind: large ? 'none' : 'mock' });
  const plan = planUnits(toTranslationDocument(ir, translation.selectionBlockIds), translation.targetLanguage, translation.profile, translation.budget, translation);
  translation.units = plan.units.map(unit => ({ id: unit.id, part: unit.part, blockId: plan.inputs[unit.blockIndex].id, status: 'covered-by-block' }));
  translation.blocks = large ? ir.blocks.map(b => ({ blockId: b.id, status: 'source-only', reason: 'language-not-required' })) : plan.inputs.map(input => ({ blockId: input.id, status: 'translated', rawText: `${prefix}${input.protectedText}` }));
  files.set('source-ir.json', json(ir)); translation.readerIrSha256 = hash(files.get('source-ir.json')!); files.set('translation.json', json(translation));
  const build = buildReader(ir, translation);
  for (const key of files.keys()) if (key.startsWith('render/')) files.delete(key);
  for (const file of createStaticFilePlan(build, { title: ir.metadata.title, originalFilename: ir.metadata.originalFilename }).generatedFiles) files.set(file.path, Buffer.from(file.content));
  Object.assign(manifest, { packageId: randomUUID(), title: ir.metadata.title, source: ir.source, parse: { ...manifest.parse, id: ir.parse.id }, readerIrSha256: translation.readerIrSha256, translation: { id: translation.id, sha256: hash(files.get('translation.json')!), status: translation.status, generationKind: translation.generationKind } });
  const previous = new Map(manifest.files.map(file => [file.path, file]));
  manifest.files = [...files].filter(([path]) => path !== 'manifest.json').map(([path, bytes]) => ({ ...(previous.get(path) ?? { path, role: 'render', mediaType: 'text/javascript' }), bytes: bytes.length, sha256: hash(bytes) }));
  files.set('manifest.json', json(manifest));
  const zip = new ZipFile(); for (const [path, bytes] of files) zip.addBuffer(bytes, path);
  const chunks: Buffer[] = []; const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
  zip.end();
  return { name: 'reader.zip', mimeType: 'application/zip', buffer: await done, pdf, build, ir };
}
