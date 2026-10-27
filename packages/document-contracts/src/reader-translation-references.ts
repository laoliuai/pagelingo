import { readerContractCeilings } from './reader-limits.js';
import { requireContract as check, uniqueById } from './reader-common.js';
import { validateReaderGraph, type ReaderIR } from './reader.js';
import { readerTranslationSchema, type ReaderTranslation, type ReaderTranslationBlock } from './reader-translation.js';

/** Identity and result consistency only. Task 2 additionally replays SDK planning/markers and
 * the byte adapter verifies readerIrSha256/glossarySha256 against actual canonical bytes. */
export function validateReaderTranslationReferences(ir: ReaderIR, input: ReaderTranslation): void {
  validateReaderGraph(ir);
  const translation = readerTranslationSchema.parse(input);
  check(translation.sourceSha256 === ir.source.sha256, 'Translation source identity mismatch');
  check(translation.parseId === ir.parse.id, 'Translation parse identity mismatch');
  const texts = ir.blocks.filter(block => block.type === 'text');
  const textIds = new Set(texts.map(block => block.id));
  const selected = new Set(translation.selectionBlockIds);
  const selectionIndices = new Map(translation.selectionBlockIds.map((id, index) => [id, index]));
  check(selected.size === translation.selectionBlockIds.length, 'Duplicate selected block');
  check(translation.selectionBlockIds.every(id => textIds.has(id)), 'Unknown selected text block');
  check(texts.filter(block => selected.has(block.id)).every((block, index) => block.id === translation.selectionBlockIds[index]), 'Selection must follow IR reading order');
  const results = new Map<string, ReaderTranslationBlock>();
  for (const result of translation.blocks) {
    check(textIds.has(result.blockId) && !results.has(result.blockId), 'Unknown or duplicate translation block');
    if (result.status === 'translated') check(new TextEncoder().encode(result.rawText).byteLength <= readerContractCeilings.maxTextBytes, 'Translated text byte limit exceeded');
    results.set(result.blockId, result);
  }
  check(results.size === texts.length, 'Every text block needs an explicit result');
  const required = new Set<string>();
  for (const block of texts) {
    const result = results.get(block.id)!;
    const noLanguage = block.language.reason === 'no-language';
    const notRequired = block.language.language === 'zh' || noLanguage;
    if (!notRequired || selected.has(block.id)) required.add(block.id);
    if (result.status === 'translated') check(selected.has(block.id), 'Translated block must be selected');
    if (result.status === 'source-only') {
      if (notRequired && !selected.has(block.id)) check(result.reason === 'language-not-required' || result.reason === 'manual-choice', 'Unselected text requiring no translation cannot have unfinished work');
      if (result.reason === 'language-not-required') check(notRequired && !selected.has(block.id), 'Invalid language-not-required result');
      if (['pending', 'failed', 'cancelled'].includes(result.reason) && selected.has(block.id)) required.add(block.id);
      check(result.reason !== 'manual-choice' || !selected.has(block.id), 'Selected block cannot be manual-choice');
    }
  }
  uniqueById(translation.units, 'translation unit');
  const parts = new Map<string, number[]>();
  const unitStatuses = new Map<string, string[]>();
  for (const unit of translation.units) {
    const index = selectionIndices.get(unit.blockId);
    check(index !== undefined, 'Unit references an unselected block');
    check(unit.id === `u${index}:${unit.part}`, 'Unit identity does not match selected block/part');
    if (unit.status === 'completed') check(new TextEncoder().encode(unit.rawText).byteLength <= readerContractCeilings.maxTextBytes, 'Translated unit byte limit exceeded');
    const blockParts = parts.get(unit.blockId) ?? []; blockParts.push(unit.part); parts.set(unit.blockId, blockParts);
    const statuses = unitStatuses.get(unit.blockId) ?? []; statuses.push(unit.status); unitStatuses.set(unit.blockId, statuses);
    if (unit.status === 'covered-by-block') check(results.get(unit.blockId)?.status === 'translated', 'Covered unit requires translated block result');
  }
  for (const id of selected) {
    const result = results.get(id)!;
    const blockParts = parts.get(id) ?? [];
    // SDK plan failures have zero units. A validated complete-block cache may supersede
    // that failure; the renderer checks the actual SDK plan and full-block markers.
    check(blockParts.length > 0 || result.status === 'translated' || (result.status === 'source-only' && result.reason === 'failed'), 'Missing translation units');
    check(blockParts.every((part, index) => part === index), 'Missing, duplicate or unordered unit parts');
    const statuses = unitStatuses.get(id) ?? [];
    if (result.status === 'translated') check(statuses.every(status => status === 'completed' || status === 'covered-by-block'), 'Translated block has unfinished units');
    if (result.status === 'source-only' && blockParts.length > 0) {
      check(statuses.some(status => status === result.reason), 'Source-only block reason must match an unfinished unit');
    }
  }
  const translated = translation.blocks.filter(block => block.status === 'translated').length;
  check(translation.generationKind !== 'none' || translated === 0, 'Generated results require model or mock generationKind');
  if (translation.generationKind === 'model') check(translation.provider.model && translation.provider.endpointFingerprint, 'Model generation requires provider identity');
  const allRequiredComplete = [...required].every(id => results.get(id)?.status === 'translated');
  if (translation.status === 'not-required') check(required.size === 0 && translated === 0 && selected.size === 0, 'Not-required contains text requiring translation');
  else if (translation.status === 'completed') check(required.size > 0 && allRequiredComplete, 'Completed translation has untranslated text');
  else if (translation.status === 'partial') check(translated > 0 && !allRequiredComplete, 'Partial translation needs both success and remaining text');
  else {
    check(required.size > 0 && translated === 0, 'Pending/failed/cancelled must have required text and no successful blocks');
    if (translation.status === 'pending') check(translation.blocks.some(block => block.status === 'source-only' && (block.reason === 'pending' || block.reason === 'manual-choice')), 'Pending status requires pending or manually unselected text');
    if (translation.status === 'failed' || translation.status === 'cancelled') {
      check(translation.blocks.some(block => block.status === 'source-only' && block.reason === translation.status), 'Terminal status requires a matching block result');
    }
  }
}
