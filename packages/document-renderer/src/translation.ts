import { readerIrSchema, readerTranslationSchema, validateReaderTranslationReferences, validateReaderGraph, type ReaderIR, type ReaderTranslation } from '@pagelingo/document-contracts';
import { planUnits, validateStructure, decodeTranslation, stripContinuation, PROMPT_VERSION, PROTECTION_VERSION, type TranslationDocument, type TranslationBlock } from '@pagelingo/translation-core';

export interface ValidatedTranslation {
  /** Only SDK-decoded source objects; hashes must be checked by the byte adapter first. */
  blocks: ReadonlyMap<string, TranslationBlock>;
  sourceOnlyReasons: ReadonlyMap<string, 'language-not-required' | 'manual-choice' | 'pending' | 'failed' | 'cancelled'>;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The sole Reader → SDK projection. Source order and bindings remain authoritative. */
export function toTranslationDocument(ir: ReaderIR, selectionBlockIds: string[], sourceLanguage?: string): TranslationDocument {
  const selected = new Set(selectionBlockIds);
  check(selected.size === selectionBlockIds.length, 'Duplicate selection');
  const blocks = ir.blocks.filter((block): block is Extract<ReaderIR['blocks'][number], { type: 'text' }> => block.type === 'text' && selected.has(block.id));
  check(blocks.length === selected.size && blocks.every((block, index) => block.id === selectionBlockIds[index]), 'Selection must follow text reading order');
  const language = sourceLanguage ?? (['en', 'zh'].includes(ir.metadata.language.language) ? ir.metadata.language.language : undefined);
  return { id: ir.parse.id, title: ir.metadata.title, ...(language ? { sourceLanguage: language } : {}), blocks: blocks.map(block => structuredClone(block.value)) };
}

/** This checks structure, identities and SDK replay, never hashes arbitrary in-memory JSON. */
export function validateReaderTranslation(irInput: ReaderIR, input: ReaderTranslation): ValidatedTranslation {
  const ir = readerIrSchema.parse(irInput);
  validateReaderGraph(ir);
  const translation = readerTranslationSchema.parse(input);
  validateReaderTranslationReferences(ir, translation);
  check(translation.sdkVersion === '0.4.0' && translation.promptVersion === PROMPT_VERSION && translation.protectionVersion === PROTECTION_VERSION, 'Unsupported SDK/prompt/protection version');
  const document = toTranslationDocument(ir, translation.selectionBlockIds, translation.sourceLanguage ?? undefined);
  const plan = planUnits(document, translation.targetLanguage, translation.profile, translation.budget, translation);
  const units = new Map(translation.units.map(unit => [unit.id, unit]));
  check(units.size === translation.units.length && units.size === plan.units.length, 'Missing or duplicate planned units');
  const plannedIds = new Set(plan.units.map(unit => unit.id));
  check([...units.keys()].every(id => plannedIds.has(id)), 'Unknown unit');
  const results = new Map(translation.blocks.map(result => [result.blockId, result]));
  const byBlock = new Map<number, typeof plan.units>();
  for (const unit of plan.units) {
    const list = byBlock.get(unit.blockIndex) ?? []; list.push(unit); byBlock.set(unit.blockIndex, list);
    const result = units.get(unit.id)!;
    check(result.blockId === plan.inputs[unit.blockIndex].id && result.part === unit.part, 'Unit identity mismatch');
    if (result.status === 'completed') check(validateStructure(unit.input, result.rawText).length === 0, 'Invalid unit markers');
    if (result.status === 'covered-by-block') check(results.get(result.blockId)?.status === 'translated', 'Covered unit without complete block');
  }
  const blocks = new Map<string, TranslationBlock>();
  const sourceOnlyReasons = new Map<string, 'language-not-required' | 'manual-choice' | 'pending' | 'failed' | 'cancelled'>();
  for (const result of translation.blocks) if (result.status === 'source-only') sourceOnlyReasons.set(result.blockId, result.reason);
  for (const [index, source] of document.blocks.entries()) {
    const result = results.get(source.id)!;
    const blockUnits = byBlock.get(index) ?? [];
    if (result.status !== 'translated') {
      if (blockUnits.length === 0) check(plan.failures.some(failure => failure.id === source.id) && result.reason === 'failed', 'Zero units require SDK planning failure');
      continue;
    }
    const plannedInput = plan.inputs[index];
    check(validateStructure(plannedInput, result.rawText).length === 0, 'Invalid full-block markers');
    if (blockUnits.length && blockUnits.every(unit => units.get(unit.id)!.status === 'completed')) {
      const assembled = blockUnits.map(unit => {
        const saved = units.get(unit.id)!;
        check(saved.status === 'completed', 'Incomplete unit');
        return stripContinuation(unit.input, saved.rawText);
      }).join('');
      check(assembled === result.rawText, 'Block does not match completed units');
    }
    // A complete block cache can supersede planning failure or cover raw-less units.
    blocks.set(source.id, { ...source, content: decodeTranslation(plannedInput, result.rawText) });
  }
  return { blocks, sourceOnlyReasons };
}
