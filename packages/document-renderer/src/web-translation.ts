import { webReaderIrSchema, webTranslationSchema, defaultCaptureLimits, type WebReaderIR, type WebTranslation, type WebImportedTranslation } from '@pagelingo/document-contracts';
import { encodeBlock, validateStructure, decodeTranslation, PROMPT_VERSION, PROTECTION_VERSION, type TranslationDocument, type TranslationBlock } from '@pagelingo/translation-core';
import { validateWebGraph } from '@pagelingo/web-capture';
import { replayTranslation, type ValidatedTranslation } from './translation.js';
export type ValidatedWebTranslation = ValidatedTranslation;
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Ordered text selection, exactly as for the PDF SDK projection. */
export function toWebTranslationDocument(ir: WebReaderIR, selectionBlockIds: string[], sourceLanguage?: string): TranslationDocument {
  validateWebGraph(ir);
  const selected = new Set(selectionBlockIds);
  check(selected.size === selectionBlockIds.length && selected.size <= defaultCaptureLimits.maxBlocks, 'Duplicate or excessive selection');
  const blocks = ir.blocks.filter(block => block.type === 'text' && selected.has(block.id));
  check(blocks.length === selected.size && blocks.every((block, index) => block.id === selectionBlockIds[index]), 'Selection must follow text reading order');
  if (sourceLanguage !== undefined) check(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(sourceLanguage) && sourceLanguage.length <= 63 && !['und', 'mul', 'zxx'].includes(sourceLanguage.toLowerCase()), 'Invalid explicit source language');
  const language = sourceLanguage ?? (['en', 'zh'].includes(ir.metadata.language.language) ? ir.metadata.language.language : undefined);
  return { id: ir.parse.id, title: ir.metadata.title, ...(language ? { sourceLanguage: language } : {}), blocks: blocks.map(block => { check(block.type === 'text', 'Expected text'); return structuredClone(block.value); }) };
}

/** Structural/SDK replay only: byte adapters MUST verify actual IR and glossary bytes/hashes first. */
export function validateWebTranslation(irInput: WebReaderIR, input: WebTranslation): ValidatedWebTranslation {
  const ir = webReaderIrSchema.parse(irInput); validateWebGraph(ir);
  const t = webTranslationSchema.parse(input);
  check(t.sourceSha256 === ir.source.manifestSha256 && t.parseId === ir.parse.id, 'Web translation identity mismatch');
  if (t.generationKind === 'import') return replayImportedTranslation(ir, t);
  const document = toWebTranslationDocument(ir, t.selectionBlockIds, t.sourceLanguage ?? undefined);
  const selected = new Set(t.selectionBlockIds), texts = ir.blocks.filter(b => b.type === 'text');
  const textIds = new Set(texts.map(b => b.id)), results = new Map(t.blocks.map(b => [b.blockId, b]));
  check(results.size === t.blocks.length && results.size === texts.length && [...results.keys()].every(id => textIds.has(id)), 'Every Web text needs one explicit result');
  const required = new Set<string>();
  for (const block of texts) {
    const result = results.get(block.id)!;
    const notRequired = block.language.language === 'zh' || block.language.reason === 'no-language';
    if (!notRequired || selected.has(block.id)) required.add(block.id);
    if (result.status === 'translated') {
      check(selected.has(block.id), 'Translated block must be selected');
      check(new TextEncoder().encode(result.rawText).length <= defaultCaptureLimits.maxOversizedBlockBytes, 'Translated Web text byte limit');
    } else {
      if (notRequired && !selected.has(block.id)) check(['language-not-required', 'manual-choice'].includes(result.reason), 'Unselected language requires no work');
      check(result.reason !== 'language-not-required' || (notRequired && !selected.has(block.id)), 'Invalid language-not-required result');
      check(result.reason !== 'manual-choice' || !selected.has(block.id), 'Selected block cannot be manual-choice');
    }
  }
  const parts = new Map<string, number[]>(), statuses = new Map<string, string[]>();
  const ids = new Set<string>();
  const indices = new Map(t.selectionBlockIds.map((id, index) => [id, index]));
  for (const unit of t.units) {
    check(!ids.has(unit.id), 'Duplicate unit'); ids.add(unit.id);
    check(indices.has(unit.blockId) && unit.id === `u${indices.get(unit.blockId)}:${unit.part}`, 'Unit selection identity mismatch');
    if (unit.status === 'completed') check(new TextEncoder().encode(unit.rawText).length <= defaultCaptureLimits.maxOversizedBlockBytes, 'Unit byte limit');
    const list = parts.get(unit.blockId) ?? []; list.push(unit.part); parts.set(unit.blockId, list);
    const states = statuses.get(unit.blockId) ?? []; states.push(unit.status); statuses.set(unit.blockId, states);
  }
  for (const id of selected) {
    const result = results.get(id)!, list = parts.get(id) ?? [], states = statuses.get(id) ?? [];
    check(list.every((part, i) => part === i), 'Unordered unit parts');
    if (result.status === 'translated') check(states.every(state => ['completed', 'covered-by-block'].includes(state)), 'Translated block has unfinished units');
    else if (list.length) check(states.includes(result.reason), 'Source-only reason must match unfinished unit');
  }
  const translated = t.blocks.filter(b => b.status === 'translated').length;
  check(t.generationKind !== 'none' || translated === 0, 'Generated results need generation kind');
  if (t.generationKind === 'model') check(t.provider.model && t.provider.endpointFingerprint, 'Missing provider identity');
  const complete = [...required].every(id => results.get(id)?.status === 'translated');
  if (t.status === 'not-required') check(!required.size && !translated && !selected.size, 'Invalid not-required status');
  else if (t.status === 'completed') check(required.size && complete, 'Incomplete completed translation');
  else if (t.status === 'partial') check(translated && !complete, 'Invalid partial status');
  else {
    check(required.size && !translated, 'Unfinished status contains successful blocks');
    check(t.blocks.some(b => b.status === 'source-only' && (b.reason === t.status || (t.status === 'pending' && b.reason === 'manual-choice'))), 'Status needs matching source-only reason');
  }
  return replayTranslation(document, t);
}

/** Import replay deliberately uses whole-block SDK protection, not fabricated unit budgets. */
function replayImportedTranslation(ir: WebReaderIR, t: WebImportedTranslation): ValidatedWebTranslation {
  check(t.sdkVersion === '0.4.0' && t.promptVersion === PROMPT_VERSION && t.protectionVersion === PROTECTION_VERSION, 'Unsupported import versions');
  check(t.sourceSnapshotSha256 === ir.source.snapshotSha256, 'Import snapshot mismatch');
  const texts = ir.blocks.filter(b => b.type === 'text');
  const blocks = new Map<string, TranslationBlock>();
  const sourceOnlyReasons = new Map<string, 'language-not-required' | 'pending'>();
  const byId = new Map(texts.map(b => [b.id, b]));
  for (const proof of t.blocks) {
    const source = byId.get(proof.blockId);
    check(source && !blocks.has(source.id) && source.sourceRefs.some(r => r.nodeId === proof.nodeId), 'Import source identity mismatch');
    check(JSON.stringify({ ...proof.source, id: source.id }) === JSON.stringify(source.value), 'Import original structure mismatch');
    const encoded = encodeBlock(source.value);
    check(validateStructure(encoded, proof.rawText).length === 0, 'Invalid imported markers');
    blocks.set(source.id, { ...source.value, content: decodeTranslation(encoded, proof.rawText) });
  }
  for (const source of texts) if (!blocks.has(source.id)) sourceOnlyReasons.set(source.id,
    ir.metadata.language.language === 'zh' || source.language.language === 'zh' || source.language.reason === 'no-language' ? 'language-not-required' : 'pending');
  const complete = ![...sourceOnlyReasons.values()].includes('pending');
  check(t.status === (complete ? 'completed' : 'partial'), 'Invalid import completion status');
  return { blocks, sourceOnlyReasons };
}
