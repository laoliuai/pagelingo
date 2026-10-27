import { z } from 'zod';
import { parseCoverageSchema, parseIdSchema, safePositiveIntegerSchema, sha256Schema } from './reader-common.js';

const coordinate = z.number();
export const pdfBoxSchema = z.tuple([coordinate, coordinate, coordinate, coordinate]);
export const normalizedPdfBoxSchema = z.tuple([
  coordinate.min(0).max(1), coordinate.min(0).max(1), coordinate.min(0).max(1), coordinate.min(0).max(1),
]);
/** bbox is already rotated-CropBox, top-left, normalized 0–1. Do not transform it again. */
export const pdfSourceRefSchema = z.discriminatedUnion('precision', [
  z.strictObject({ pageIndex: z.number().int().nonnegative(), precision: z.literal('page') }),
  z.strictObject({ pageIndex: z.number().int().nonnegative(), precision: z.literal('bbox'), bbox: normalizedPdfBoxSchema }),
]);
export type PdfSourceRef = z.infer<typeof pdfSourceRefSchema>;
export const pdfPageMetadataSchema = z.strictObject({
  pageIndex: z.number().int().nonnegative(),
  mediaBox: pdfBoxSchema,
  cropBox: pdfBoxSchema,
  displayCropBox: pdfBoxSchema,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  /** Display dimensions in PDF points at scale 1. */
  displayWidth: z.number().positive(), displayHeight: z.number().positive(),
  /** [a,b,c,d,e,f] maps original PDF user-space points to rotated effective-CropBox
   * display POINTS, as PDF.js viewport.transform at scale 1. Divide the result by
   * displayWidth/displayHeight only when constructing a normalized bbox. */
  pdfToDisplay: z.tuple([coordinate, coordinate, coordinate, coordinate, coordinate, coordinate]),
});
export type PdfPageMetadata = z.infer<typeof pdfPageMetadataSchema>;
export const readerPdfSourceSchema = z.strictObject({
  kind: z.literal('pdf'), sha256: sha256Schema, bytes: safePositiveIntegerSchema, pageCount: safePositiveIntegerSchema,
});
export type ReaderPdfSource = z.infer<typeof readerPdfSourceSchema>;
export const readerParseSchema = z.strictObject({
  id: parseIdSchema, inputManifestSha256: sha256Schema, projectorVersion: z.string().min(1), configSha256: sha256Schema,
  parserName: z.string().min(1), parserVersion: z.string().min(1).nullable(),
  modelLockSha256: sha256Schema.nullable(), pythonLockSha256: sha256Schema.nullable(),
  coverage: parseCoverageSchema, status: z.enum(['complete', 'partial']),
  requestedPageIndices: z.array(z.number().int().nonnegative()), parsedPageIndices: z.array(z.number().int().nonnegative()),
});
export type ReaderParse = z.infer<typeof readerParseSchema>;
