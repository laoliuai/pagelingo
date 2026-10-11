import { z } from 'zod';

export const glossaryDomainSchema = z.enum(['all', 'machine-learning', 'software-engineering', 'physics', 'general-technical']);
export const MAX_GLOSSARY_ENTRIES = 2000;
export const MAX_GLOSSARY_FILE_BYTES = 5 * 1024 * 1024;

export const glossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(120).refine(source => !/[⟦⟧]/.test(source), '原词不能包含翻译引擎的占位分隔符。'),
  target: z.string().trim().max(240),
  policy: z.enum(['keep', 'translate', 'first-bilingual', 'prefer-source']),
  domain: glossaryDomainSchema,
}).refine((entry) => entry.policy !== 'translate' || entry.target.length > 0, {
  message: '固定翻译的术语必须填写译文。',
  path: ['target'],
}).refine((entry) => ['keep', 'prefer-source'].includes(entry.policy) || !/[⟦⟧]/.test(entry.target), {
  message: '译文不能包含翻译引擎的占位标记。', path: ['target'],
});

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export function glossaryKey(entry: Pick<GlossaryEntry, 'source' | 'domain'>): string {
  return JSON.stringify([entry.source.trim().toLowerCase(), entry.domain]);
}

/** The latest occurrence wins, including repetitions within either input. */
export function mergeGlossaryEntries(existing: readonly GlossaryEntry[], incoming: readonly GlossaryEntry[]): GlossaryEntry[] {
  const entries = z.array(glossaryEntrySchema).parse([...existing, ...incoming]);
  const merged = new Map<string, GlossaryEntry>();
  for (const entry of entries) {
    const key = glossaryKey(entry);
    merged.delete(key); merged.set(key, entry);
  }
  if (merged.size > MAX_GLOSSARY_ENTRIES) throw new Error(`术语表最多保存 ${MAX_GLOSSARY_ENTRIES} 个不同词条。`);
  return [...merged.values()];
}

function readDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  const flushCell = () => { row.push(cell); cell = ''; closed = false; };
  const flushRow = () => { flushCell(); if (row.some(value => value.trim())) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === separator) flushCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; flushRow(); }
    else if (char === '"') {
      if (cell || closed) throw new Error('表格引号格式不正确。');
      quoted = true;
    } else if (closed && !/\s/.test(char)) throw new Error('表格引号结束后包含多余内容。');
    else if (!closed) cell += char;
  }
  if (quoted) throw new Error('表格中有未闭合的引号。');
  flushRow(); return rows;
}

/** Pure, portable file decoding; the caller owns file selection and persistence. */
export function parseGlossaryFile(value: string, format: 'json' | 'csv' | 'tsv'): GlossaryEntry[] {
  if (new TextEncoder().encode(value).byteLength > MAX_GLOSSARY_FILE_BYTES) throw new Error('词表文件不能超过 5 MiB。');
  const text = value.replace(/^\uFEFF/, '');
  if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('JSON 格式不正确，请使用词条数组。'); }
    return mergeGlossaryEntries([], z.array(glossaryEntrySchema).parse(parsed));
  }
  const [rawHeader, ...rows] = readDelimited(text, format === 'tsv' ? '\t' : ',');
  if (!rawHeader) throw new Error('词表为空，请提供 source 和 target 表头。');
  const header = rawHeader.map(name => name.trim().toLowerCase());
  if (!header.includes('source') || !header.includes('target') || new Set(header).size !== header.length) {
    throw new Error('表头必须包含 source、target，且列名不能重复。');
  }
  const entries = rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`第 ${index + 2} 行的列数与表头不一致。`);
    const fields = Object.fromEntries(header.map((key, column) => [key, row[column].trim()]));
    const parsed = glossaryEntrySchema.safeParse({ source: fields.source, target: fields.target,
      policy: fields.policy || (fields.target ? 'translate' : 'keep'), domain: fields.domain || 'all' });
    if (!parsed.success) throw new Error(`第 ${index + 2} 行：${parsed.error.issues.map(issue => issue.message).join('；')}`);
    return parsed.data;
  });
  return mergeGlossaryEntries([], entries);
}
