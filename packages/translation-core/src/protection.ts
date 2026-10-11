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

/** Restores data only. The consuming adapter decides how to render or escape it. */
export function decodeTranslation(input: TranslationInput, text: string): InlineContent[] {
  const errors = validateStructure(input, text);
  if (errors.length) throw new Error(errors.join(' '));
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
