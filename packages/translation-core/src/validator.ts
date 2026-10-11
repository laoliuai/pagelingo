import { translationOutputSchema, type TranslationInput, type TranslationOutput } from './types.js';

export const SLOT_PATTERN = /⟦[^⟦⟧]*⟧/g;

export function validateStructure(input: TranslationInput, text: string): string[] {
  const errors: string[] = [];
  const slots = new Map(input.slots.map((slot) => [slot.token, slot]));
  const occurrences = new Map<string, number>();
  const stack: string[] = [];
  if (slots.size !== input.slots.length) errors.push('输入中存在重复的占位符定义。');

  for (const token of text.match(SLOT_PATTERN) ?? []) {
    occurrences.set(token, (occurrences.get(token) ?? 0) + 1);
    const slot = slots.get(token);
    if (!slot) {
      errors.push('译文包含未知占位符。');
    } else if (slot.kind === 'open') {
      stack.push(slot.pair);
    } else if (slot.kind === 'close' && stack.pop() !== slot.pair) {
      errors.push(`格式标记嵌套错误：${token}`);
    }
  }
  for (const slot of input.slots) {
    if (occurrences.get(slot.token) !== 1) errors.push(`占位符缺失或重复：${slot.token}`);
  }
  if (stack.length) errors.push('格式标记未闭合。');
  if (!text.trim()) errors.push('译文为空。');
  if (input.continuation && (!text.startsWith(input.continuation.prefix) || !text.endsWith(input.continuation.suffix))) errors.push('分片续接边界被模型改变。');
  return errors;
}

export function validateBatch(inputs: TranslationInput[], value: unknown): TranslationOutput {
  const result = translationOutputSchema.safeParse(value);
  // Do not forward Zod's unknown-key diagnostics or arbitrary model markers to the page.
  if (!result.success) throw new Error('返回的译文结构不符合要求。');
  const parsed = result.data;
  const expected = new Map(inputs.map((input) => [input.id, input]));
  if (expected.size !== inputs.length) throw new Error('输入中存在重复的文本块 ID。');
  const seen = new Set<string>();
  for (const result of parsed.translations) {
    const input = expected.get(result.id);
    if (!input || seen.has(result.id)) throw new Error('返回了未知或重复的文本块。');
    seen.add(result.id);
    const errors = validateStructure(input, result.text);
    if (errors.length) throw new Error(errors.join(' '));
  }
  if (seen.size !== expected.size) throw new Error('返回结果缺少文本块。');
  return parsed;
}
