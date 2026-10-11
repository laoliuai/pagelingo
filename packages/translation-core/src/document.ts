import { z } from 'zod';

export const blockKindSchema = z.enum(['paragraph', 'heading', 'list-item', 'quote', 'caption', 'table-cell']);
export type BlockKind = z.infer<typeof blockKindSchema>;

export const protectedKindSchema = z.enum(['code', 'math', 'citation', 'identifier', 'url', 'literal']);
export type ProtectedKind = z.infer<typeof protectedKindSchema>;

export const formatKindSchema = z.enum(['strong', 'emphasis', 'link', 'subscript', 'superscript', 'deletion', 'small', 'mark']);
export type FormatKind = z.infer<typeof formatKindSchema>;

export interface TextInline {
  type: 'text';
  text: string;
}

/** id is local to a block and refers to an adapter-owned source map. */
export interface ProtectedInline {
  type: 'protected';
  id: string;
  kind: ProtectedKind;
  source: string;
}

export interface FormatInline {
  type: 'format';
  id: string;
  kind: FormatKind;
  children: InlineContent[];
}

export type InlineContent = TextInline | ProtectedInline | FormatInline;

export interface TranslationBlock {
  id: string;
  kind: BlockKind;
  sectionPath?: string[];
  content: InlineContent[];
}

export interface TranslationDocument {
  id: string;
  title?: string;
  sourceLanguage?: string;
  blocks: TranslationBlock[];
}

export const inlineContentSchema: z.ZodType<InlineContent> = z.lazy(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('protected'), id: z.string().min(1), kind: protectedKindSchema, source: z.string() }),
  z.strictObject({ type: z.literal('format'), id: z.string().min(1), kind: formatKindSchema, children: z.array(inlineContentSchema) }),
]));

export const translationBlockSchema: z.ZodType<TranslationBlock> = z.strictObject({
  id: z.string().min(1),
  kind: blockKindSchema,
  sectionPath: z.array(z.string().min(1)).optional(),
  content: z.array(inlineContentSchema),
}).superRefine((block, context) => {
  const seen = new Set<string>();
  function visit(content: InlineContent[]): void {
    for (const inline of content) {
      if (inline.type === 'text') continue;
      if (seen.has(inline.id)) context.addIssue({ code: 'custom', message: `重复的行内对象 ID：${inline.id}` });
      seen.add(inline.id);
      if (inline.type === 'format') visit(inline.children);
    }
  }
  visit(block.content);
});

/** Parsing also snapshots the document so later caller edits cannot alter a running job. */
export const translationDocumentSchema: z.ZodType<TranslationDocument> = z.strictObject({
  id: z.string().min(1),
  title: z.string().optional(),
  sourceLanguage: z.string().min(1).optional(),
  blocks: z.array(translationBlockSchema),
}).superRefine((document, context) => {
  const seen = new Set<string>();
  for (const block of document.blocks) {
    if (seen.has(block.id)) context.addIssue({ code: 'custom', message: `重复的文本块 ID：${block.id}` });
    seen.add(block.id);
  }
});
