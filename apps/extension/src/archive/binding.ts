import { z } from 'zod';
import { deviceExchangeResultSchema } from '@pagelingo/document-contracts';

export function siteOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('站点须为 HTTPS 地址，或本机开发地址；请只填写协议、主机与端口。');
  }
  return url.origin;
}
// Chrome host grants do not distinguish ports. All actual requests still use the exact stored origin.
export function hostPermission(value: string): string { const url = new URL(value); return `${url.protocol}//${url.hostname}/*`; }
export const siteBindingSchema = z.strictObject({ siteOrigin: z.string().transform(siteOrigin), siteId: z.uuid(), ownerId: z.uuid(), deviceId: z.uuid(), generation: z.uuid() });
export type SiteBinding = z.infer<typeof siteBindingSchema>;
export interface SiteConnection { binding: SiteBinding; token: string; username: string; expiresAt: string }
export const BINDING_KEY = 'archiveSiteConnection';
export function partition(binding: SiteBinding): string { return JSON.stringify([binding.siteOrigin, binding.siteId, binding.ownerId]); }
export function sameBinding(a: SiteBinding | null, b: SiteBinding): boolean { return !!a && partition(a) === partition(b) && a.deviceId === b.deviceId && a.generation === b.generation; }
export async function readConnection(): Promise<SiteConnection | null> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const stored = (await chrome.storage.local.get(BINDING_KEY))[BINDING_KEY] as SiteConnection | undefined;
  if (!stored) return null;
  return { ...stored, binding: siteBindingSchema.parse(stored.binding) };
}
export async function storeConnection(origin: string, response: unknown): Promise<SiteConnection> {
  const result = deviceExchangeResultSchema.parse(response);
  const connection: SiteConnection = { binding: { siteOrigin: siteOrigin(origin), siteId: result.siteId, ownerId: result.owner.id, deviceId: result.device.id, generation: crypto.randomUUID() }, token: result.token, username: result.owner.username, expiresAt: result.device.expiresAt };
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.local.set({ [BINDING_KEY]: connection });
  return connection;
}
export async function disconnectSite(): Promise<void> { await chrome.storage.local.remove(BINDING_KEY); }
