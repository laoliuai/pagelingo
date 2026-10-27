import { z } from 'zod';
import { safeNonnegativeIntegerSchema } from './reader-common.js';
/** GET may use a session or preferences:read device; PUT requires a session. */
export const savePreferencesSchema = z.strictObject({ revision: safeNonnegativeIntegerSchema, autoTranslate: z.boolean() });
export type SavePreferences = z.infer<typeof savePreferencesSchema>;
export const defaultSavePreferences: Readonly<SavePreferences> = Object.freeze({ revision: 0, autoTranslate: false });
export const savePreferencesUpdateSchema = z.strictObject({ expectedRevision: safeNonnegativeIntegerSchema, autoTranslate: z.boolean() });
export type SavePreferencesUpdate = z.infer<typeof savePreferencesUpdateSchema>;
