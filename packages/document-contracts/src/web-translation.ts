import { z } from 'zod';
import { readerTranslationShapeSchema } from './reader-translation.js';
import { withJsonDepthLimit } from './reader-common.js';
/** Same SDK replay records and byte identity binding, with a distinct Web version. */
export const webTranslationShapeSchema = readerTranslationShapeSchema.extend({ schemaVersion: z.literal('web-reader-translation/1') });
export const webTranslationSchema = withJsonDepthLimit(webTranslationShapeSchema);
export type WebTranslation = z.infer<typeof webTranslationSchema>;
