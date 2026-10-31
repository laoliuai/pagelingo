import { translationBlockSchema, type FormatInline, type InlineContent, type TranslationBlock } from './document.js';
import type { InlineSlot, TranslationInput } from './types.js';
import { SLOT_PATTERN, validateStructure } from './validator.js';

/** Change when the encoding or restoration contract changes; future cache keys must include it. */
export const PROTECTION_VERSION = '1';

export function encodeBlock(value: TranslationBlock): TranslationInput {
  const block = translationBlockSchema.parse(value);
  const slots: InlineSlot[] = [];
  const source: string[] = [];
  let counter = 0;

  function atom(inline: Extract<InlineContent, { type: 'text' | 'protected' }>): string {
    const token = `⟦A${counter++}⟧`;
    slots.push({ token, kind: 'atom', inline });
    return token;
  }

  function encodeContent(content: InlineContent[]): string {
    let text = '';
    let output = '';
    const flush = () => {
      if (text) output += visit({ type: 'text', text });
      text = '';
    };
    // Parsers may split one literal marker over several adjacent text nodes.
    // Encode contiguous text together so it cannot masquerade as a generated slot.
    for (const inline of content) {
      if (inline.type === 'text') text += inline.text;
      else {
        flush();
        output += visit(inline);
      }
    }
    flush();
    return output;
  }

  function visit(inline: InlineContent): string {
    if (inline.type === 'text') {
      source.push(inline.text);
      return inline.text.replace(SLOT_PATTERN, (text) => atom({ type: 'text', text }));
    }
    if (inline.type === 'protected') {
      source.push(inline.source);
      return atom(inline);
    }
    const pair = String(counter++);
    const open = `⟦S${pair}⟧`;
    const close = `⟦E${pair}⟧`;
    slots.push({ token: open, kind: 'open', pair, inline: { type: 'format', id: inline.id, kind: inline.kind } });
    const text = encodeContent(inline.children);
    slots.push({ token: close, kind: 'close', pair });
    return open + text + close;
  }

  const protectedText = encodeContent(block.content);
  return {
    id: block.id, kind: block.kind, sectionPath: block.sectionPath,
    sourceText: source.join(''), protectedText, slots,
  };
}

const WIDE_CHARACTER = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
/**
 * Models space locked glossary tokens as if they were code, which leaves gaps inside Chinese text once a
 * Chinese term is restored. Spaces stay when either side is Latin, where they are normal typography.
 */
export function tightenTerminology(input: TranslationInput, text: string): string {
  const terms = new Set(input.terminologyTokens ?? []);
  if (!terms.size) return text;
  const values = new Map(input.slots.flatMap(slot => slot.kind === 'atom' && slot.inline.type === 'text' && terms.has(slot.token) ? [[slot.token, slot.inline.text] as const] : []));
  const wide = (character?: string) => !!character && WIDE_CHARACTER.test(character);
  let output = ''; let cursor = 0; let previousEnd: string | undefined;
  for (const match of [...text.matchAll(SLOT_PATTERN), null]) {
    const between = text.slice(cursor, match ? match.index : text.length);
    const value = match ? values.get(match[0]) : undefined;
    const body = between.trim();
    // Only a term's neighbours change: spacing next to code, formulas and formatting markers is left alone.
    const trimStart = previousEnd !== undefined && wide(previousEnd) && (body ? wide(body[0]) : wide(value?.[0]));
    const trimEnd = value !== undefined && wide(value[0]) && (body ? wide(body.at(-1)) : wide(previousEnd));
    let piece = between;
    if (trimStart) piece = piece.replace(/^[ \t\u00a0]+/, '');
    if (trimEnd) piece = piece.replace(/[ \t\u00a0]+$/, '');
    output += piece;
    if (!match) break;
    output += match[0];
    previousEnd = value?.at(-1);
    cursor = match.index + match[0].length;
  }
  return output;
}

/** Restores data only. The consuming adapter decides how to render or escape it. */
export function decodeTranslation(input: TranslationInput, rawText: string): InlineContent[] {
  const errors = validateStructure(input, rawText);
  if (errors.length) throw new Error(errors.join(' '));
  const text = tightenTerminology(input, rawText);
  const slots = new Map(input.slots.map((slot) => [slot.token, slot]));
  const result: InlineContent[] = [];
  const stack: InlineContent[][] = [result];
  let offset = 0;

  function appendText(text: string): void {
    if (!text) return;
    const children = stack.at(-1)!;
    const last = children.at(-1);
    if (last?.type === 'text') last.text += text;
    else children.push({ type: 'text', text });
  }

  for (const match of text.matchAll(SLOT_PATTERN)) {
    appendText(text.slice(offset, match.index));
    const slot = slots.get(match[0])!;
    if (slot.kind === 'atom') {
      if (slot.inline.type === 'text') appendText(slot.inline.text);
      else stack.at(-1)!.push({ ...slot.inline });
    } else if (slot.kind === 'open') {
      const inline: FormatInline = { ...slot.inline, children: [] };
      stack.at(-1)!.push(inline);
      stack.push(inline.children);
    } else {
      stack.pop();
    }
    offset = match.index + match[0].length;
  }
  appendText(text.slice(offset));
  return result;
}
