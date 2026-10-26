import { z } from 'zod';

export const usernameSchema = z.string().toLowerCase().pipe(z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/));

/** Count Unicode code points without trimming or truncating the supplied password. */
export const passwordSchema = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
}, 'Password must contain 12–128 Unicode code points.');

export const publicUserSchema = z.strictObject({
  id: z.uuid(),
  username: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/),
  role: z.enum(['admin', 'user']),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const sessionViewSchema = z.union([
  z.strictObject({ user: z.null(), csrfToken: z.null() }),
  z.strictObject({ user: publicUserSchema, csrfToken: z.string().min(1) }),
]);
export type SessionView = z.infer<typeof sessionViewSchema>;

export const loginRequestSchema = z.strictObject({ username: usernameSchema, password: passwordSchema });
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export const createUserRequestSchema = z.strictObject({ username: usernameSchema, password: passwordSchema });
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export const logoutRequestSchema = z.strictObject({ allDevices: z.boolean().default(false) });
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export const changePasswordRequestSchema = z.strictObject({ currentPassword: passwordSchema, newPassword: passwordSchema });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export const updateUserRequestSchema = z.strictObject({ active: z.boolean() });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export const resetPasswordRequestSchema = z.strictObject({ newPassword: passwordSchema });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
