import { z } from 'zod';

export const apiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export const errorResponseSchema = z.strictObject({ error: apiErrorSchema });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
