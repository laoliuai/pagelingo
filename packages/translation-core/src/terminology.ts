import { glossaryKey, mergeGlossaryEntries, type GlossaryEntry } from './glossary.js';
import type { AppliedGlossaryEntry, TranslationInput } from './types.js';
import { SLOT_PATTERN } from './validator.js';

const leftWord = /[\p{L}\p{N}_]$/u;
const rightWord = /^[\p{L}\p{N}_]/u;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match natural text only; protected code, math and formatting markers are untouched. */
export function applyGlossary(input: TranslationInput, entries: readonly GlossaryEntry[], domain: GlossaryEntry['domain']): TranslationInput {
  const selected = new Map<string, GlossaryEntry>();
  const normalized = mergeGlossaryEntries([], entries);
  for (const scope of ['all', domain]) for (const entry of normalized) {
    if (entry.domain === scope) selected.set(entry.source.toLowerCase(), entry);
  }
  if (!selected.size) return input;
  const candidates = [...selected.values()].sort((a, b) => b.source.length - a.source.length);
  const matchers = candidates.map(entry => ({ entry, pattern: new RegExp(escape(entry.source), 'iyu') }));
  const pattern = new RegExp(candidates.map(entry => escape(entry.source)).join('|'), 'giu');
  const slots = [...input.slots]; const tokens: string[] = []; const matches = new Map<string, AppliedGlossaryEntry>();
  const originalSlots = new Map(input.slots.map(slot => [slot.token, slot]));
  const natural = input.protectedText.replace(SLOT_PATTERN, token => originalSlots.get(token)?.kind === 'atom' ? '\0' : '');
  let counter = Math.max(-1, ...slots.map(slot => Number(slot.token.match(/\d+(?=⟧$)/)?.[0] ?? -1))) + 1;
  const replace = (text: string, start: number) => {
    let output = ''; let cursor = 0; pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const offset = match.index; const position = start + offset;
      const endsWord = (length: number) => rightWord.test(natural.slice(position + length, position + length + 2));
      if (leftWord.test(natural.slice(Math.max(0, position - 2), position))) { pattern.lastIndex = offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1); continue; }
      let source = match[0]; let entry = selected.get(source.toLowerCase());
      if (!entry || endsWord(source.length)) {
        entry = undefined;
        for (const candidate of matchers) {
          candidate.pattern.lastIndex = offset; const found = candidate.pattern.exec(text);
          if (found && !endsWord(found[0].length)) { entry = candidate.entry; source = found[0]; break; }
        }
      }
      if (!entry) { pattern.lastIndex = offset + (text.codePointAt(offset)! > 0xffff ? 2 : 1); continue; }
      const key = glossaryKey(entry); const applied = matches.get(key) ?? { ...entry, tokens: [] };
      matches.set(key, applied);
      let replacement = source;
      if (entry.policy !== 'prefer-source') {
        replacement = `⟦A${counter++}⟧`;
        const value = entry.policy === 'keep' ? source : entry.policy === 'first-bilingual' ?
          (entry.target ? `${entry.target}（${source}）` : source) : entry.target;
        slots.push({ token: replacement, kind: 'atom', inline: { type: 'text', text: value } });
        tokens.push(replacement); applied.tokens.push(replacement);
      }
      output += text.slice(cursor, offset);
      if (entry.policy === 'prefer-source') {
        const start = protectedText.length + output.length;
        (applied.ranges ??= []).push({ start, end: start + source.length });
      }
      output += replacement;
      cursor = offset + source.length; pattern.lastIndex = cursor;
    }
    return output + text.slice(cursor);
  };
  let offset = 0; let naturalOffset = 0; let protectedText = '';
  for (const match of input.protectedText.matchAll(SLOT_PATTERN)) {
    const text = input.protectedText.slice(offset, match.index);
    protectedText += replace(text, naturalOffset) + match[0];
    naturalOffset += text.length + (originalSlots.get(match[0])?.kind === 'atom' ? 1 : 0);
    offset = match.index + match[0].length;
  }
  protectedText += replace(input.protectedText.slice(offset), naturalOffset);
  if (!matches.size) return input;
  return { ...input, protectedText, slots, glossary: [...matches.values()], terminologyTokens: tokens };
}

/** Split requests carry only rules relevant to their own natural text and atom slots. */
export function unitGlossary(input: TranslationInput, protectedText: string, tokens: Set<string>, start: number, end: number): AppliedGlossaryEntry[] | undefined {
  const natural = protectedText.replace(SLOT_PATTERN, token => /^⟦[SE]\d+⟧$/.test(token) ? '' : '\0');
  const entries = input.glossary?.flatMap(entry => {
    const relevant = entry.tokens.filter(token => tokens.has(token));
    const softMatch = entry.policy === 'prefer-source' && (entry.ranges ? entry.ranges.some(range => range.start < end && range.end > start) :
      new RegExp(`(?<![\\p{L}\\p{N}_])${escape(entry.source)}(?![\\p{L}\\p{N}_])`, 'iu').test(natural));
    if (entry.policy === 'prefer-source' ? softMatch : relevant.length) {
      return [{ ...entry, tokens: relevant }];
    }
    return [];
  });
  return entries?.length ? entries : undefined;
}

/** Return the original adapter's marker vocabulary; extra term slots stay inside the SDK. */
export function restoreGlossaryText(input: TranslationInput, text: string): string {
  const terms = new Set(input.terminologyTokens ?? []);
  if (!terms.size) return text;
  const slots = new Map(input.slots.map(slot => [slot.token, slot]));
  return text.replace(SLOT_PATTERN, token => {
    const slot = slots.get(token);
    return terms.has(token) && slot?.kind === 'atom' && slot.inline.type === 'text' ? slot.inline.text : token;
  });
}
