import { z } from 'zod';
import { glossaryEntrySchema, MAX_GLOSSARY_ENTRIES } from '@pagelingo/translation-core';
import { safeNonnegativeIntegerSchema } from './reader-common.js';
export const glossaryEntriesSchema = z.array(glossaryEntrySchema.strict()).max(MAX_GLOSSARY_ENTRIES);
export const glossaryRevisionSchema = z.strictObject({ revision: safeNonnegativeIntegerSchema, entries: glossaryEntriesSchema });
export type GlossaryRevision = z.infer<typeof glossaryRevisionSchema>;
export const glossaryUpdateSchema = z.strictObject({ expectedRevision: safeNonnegativeIntegerSchema, entries: glossaryEntriesSchema });
export type GlossaryUpdate = z.infer<typeof glossaryUpdateSchema>;
