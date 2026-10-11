import type { TranslationDocument } from './document.js';
import { encodeBlock } from './protection.js';
import { buildTranslationRequest, type GenerationRequest } from './provider.js';
import type { TranslationInput, TranslationProfile, InlineSlot } from './types.js';
import { SLOT_PATTERN } from './validator.js';
import { applyGlossary, unitGlossary } from './terminology.js';
import type { TranslationOptions } from './types.js';

export interface BudgetOptions {
  maxInputTokens: number; maxOutputTokens: number; contextWindowTokens: number;
  maxBatchBlocks?: number; reserveTokens?: number;
}
export interface PlannedUnit { id: string; blockIndex: number; part: number; input: TranslationInput }
export interface BlockFailure { id: string; error: string }
export interface TranslationPlan {
  document: Omit<TranslationDocument, 'blocks'>; inputs: TranslationInput[];
  units: PlannedUnit[]; failures: BlockFailure[];
}
/** Conservative portable heuristic; replace with a model tokenizer when available. */
export function estimateTokens(text: string): number { return Math.ceil(new TextEncoder().encode(text).byteLength / 2); }
export function requestFits(request: GenerationRequest, budget: BudgetOptions): boolean {
  const input = estimateTokens(JSON.stringify(request)) + 128;
  const output = estimateTokens(JSON.stringify({ translations: request.data.blocks.map((b) => ({ id: b.id, text: b.protectedText })) })) * 1.5 + 64;
  return input <= budget.maxInputTokens && output <= budget.maxOutputTokens &&
    input + budget.maxOutputTokens + (budget.reserveTokens ?? 512) <= budget.contextWindowTokens &&
    request.data.blocks.length <= (budget.maxBatchBlocks ?? 4);
}
export function stripContinuation(input: TranslationInput, text: string): string {
  const { prefix = '', suffix = '' } = input.continuation ?? {};
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) throw new Error('分片续接边界被模型改变。');
  return text.slice(prefix.length, suffix ? -suffix.length : undefined);
}
function segments(text: string, granularity: 'sentence' | 'word' | 'grapheme'): string[] {
  return [...new Intl.Segmenter(undefined, { granularity }).segment(text)].map((part) => part.segment);
}
export function planUnits(value: TranslationDocument, language: string, profile: TranslationProfile, budget: BudgetOptions,
  terminology: Pick<TranslationOptions, 'glossary' | 'glossaryDomain'> = {}): TranslationPlan {
  for (const number of [budget.maxInputTokens, budget.maxOutputTokens, budget.contextWindowTokens, budget.maxBatchBlocks ?? 4, budget.reserveTokens ?? 512]) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Token 预算必须为正整数。');
  }
  const { blocks, ...document } = value;
  const inputs = blocks.map(block => applyGlossary(encodeBlock(block), terminology.glossary ?? [], terminology.glossaryDomain ?? 'machine-learning'));
  const units: PlannedUnit[] = []; const failures: BlockFailure[] = [];
  inputs.forEach((original, blockIndex) => {
    const start = units.length;
    const slotMap = new Map(original.slots.map((slot) => [slot.token, slot]));
    const closeMap = new Map(original.slots.filter((slot) => slot.kind === 'close').map((slot) => [slot.pair, slot.token]));
    let active: Extract<InlineSlot, { kind: 'open' }>[] = [];
    let beginning: typeof active = []; let raw = ''; let part = 0; let rawStart = 0;
    const makeInput = (text: string, ending: typeof active): TranslationInput => {
      const prefix = beginning.map((slot) => slot.token).join('');
      const suffix = [...ending].reverse().map((slot) => closeMap.get(slot.pair)!).join('');
      const protectedText = prefix + text + suffix;
      const tokens = new Set(protectedText.match(SLOT_PATTERN) ?? []);
      const sourceText = protectedText.replace(SLOT_PATTERN, (token) => {
        const slot = slotMap.get(token)!;
        return slot.kind === 'atom' ? slot.inline.type === 'text' ? slot.inline.text : slot.inline.source : '';
      });
      return { ...original, id: `u${blockIndex}:${part}`, sourceText, protectedText,
        slots: original.slots.filter((slot) => tokens.has(slot.token)), continuation: { prefix, suffix },
        glossary: unitGlossary(original, protectedText, tokens, rawStart, rawStart + text.length),
        terminologyTokens: original.terminologyTokens?.filter(token => tokens.has(token)) };
    };
    const fits = (input: TranslationInput) => requestFits(buildTranslationRequest(document, [input], language, profile), budget);
    const flush = () => {
      if (!raw) return;
      const input = makeInput(raw, active);
      units.push({ id: input.id, blockIndex, part: part++, input });
      rawStart += raw.length; raw = ''; beginning = [...active];
    };
    try {
      if (!original.protectedText.trim()) throw new Error('输入文本块为空。');
      let offset = 0;
      const pieces: Array<{ text: string; level: number }> = [];
      for (const match of original.protectedText.matchAll(SLOT_PATTERN)) {
        pieces.push(...segments(original.protectedText.slice(offset, match.index), 'sentence').map((text) => ({ text, level: 0 })));
        pieces.push({ text: match[0], level: 3 }); offset = match.index + match[0].length;
      }
      pieces.push(...segments(original.protectedText.slice(offset), 'sentence').map((text) => ({ text, level: 0 })));
      while (pieces.length) {
        const piece = pieces.shift()!;
        const slot = slotMap.get(piece.text);
        const ending = [...active];
        if (slot?.kind === 'open') ending.push(slot);
        else if (slot?.kind === 'close') ending.pop();
        const candidate = makeInput(raw + piece.text, ending);
        if (fits(candidate)) { raw += piece.text; active = ending; continue; }
        if (raw) { flush(); pieces.unshift(piece); continue; }
        if (!slot && piece.level < 2 && piece.text.length > 1) {
          pieces.unshift(...segments(piece.text, piece.level === 0 ? 'word' : 'grapheme').map((text) => ({ text, level: piece.level + 1 })));
          continue;
        }
        throw new Error('此段的保护对象或请求上下文超过 Token 预算，原文已保留。');
      }
      flush();
    } catch (error) {
      units.splice(start); failures.push({ id: original.id, error: error instanceof Error ? error.message : '无法拆分此段。' });
    }
  });
  return { document, inputs, units, failures };
}
