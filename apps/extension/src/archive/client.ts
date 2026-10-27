import { createWebCaptureRequestSchema, createDocumentLinkRequestSchema, webCaptureResultSchema, documentLinkResultSchema, deviceExchangeRequestSchema, deviceExchangeResultSchema, type CaptureFile, type CreateWebCaptureRequest, type CreateDocumentLinkRequest } from '@pagelingo/document-contracts';
import { readConnection, sameBinding, siteOrigin, hostPermission, type SiteBinding } from './binding.js';
export class ArchiveHttpError extends Error { constructor(readonly status: number, readonly code: string) { super(`站点请求失败 (${status} ${code})`); } }
async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text(); if (text.length > 16 * 1024 * 1024) throw new Error('站点响应超过限制。');
  let value: any; try { value = text ? JSON.parse(text) : null; } catch { throw new Error('站点响应格式不正确。'); }
  if (!response.ok) throw new ArchiveHttpError(response.status, value?.error?.code ?? value?.code ?? 'REQUEST_FAILED');
  return value;
}
export async function exchangeSite(origin: string, code: string) {
  origin = siteOrigin(origin);
  if (!await chrome.permissions.contains({ origins: [hostPermission(origin)] })) throw new Error('请先授权此站点。');
  return deviceExchangeResultSchema.parse(await jsonResponse(await fetch(`${origin}/api/v1/devices/exchange`, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deviceExchangeRequestSchema.parse({ code, deviceName: 'PageLingo browser', extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version })) })));
}
export function createArchiveClient(binding: SiteBinding, signal: AbortSignal) {
  async function request(path: string, init: RequestInit = {}) {
    const connection = await readConnection();
    if (!connection || !sameBinding(connection.binding, binding)) throw new Error('站点连接已变化。');
    if (!await chrome.permissions.contains({ origins: [hostPermission(binding.siteOrigin)] })) throw new Error('站点授权已撤销。');
    if (!sameBinding((await readConnection())?.binding ?? null, binding)) throw new Error('站点连接已变化。');
    const response = await fetch(`${binding.siteOrigin}/api/v1/${path}`, { ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { ...init.headers, Authorization: `Bearer ${connection.token}` } });
    return jsonResponse(response);
  }
  return {
    async create(input: CreateWebCaptureRequest, key: string) { return webCaptureResultSchema.parse(await request('captures', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(createWebCaptureRequestSchema.parse(input)) })); },
    async status(id: string) { return webCaptureResultSchema.parse(await request(`captures/${encodeURIComponent(id)}`)); },
    async put(id: string, file: CaptureFile, bytes: Uint8Array) { await request(`captures/${encodeURIComponent(id)}/files/${encodeURIComponent(file.id)}`, { method: 'PUT', headers: { 'Content-Type': file.mediaType }, body: bytes as BodyInit }); },
    async commit(id: string) { return webCaptureResultSchema.parse(await request(`captures/${encodeURIComponent(id)}/commit`, { method: 'POST' })); },
    async cancel(id: string) { return webCaptureResultSchema.parse(await request(`captures/${encodeURIComponent(id)}/cancel`, { method: 'POST' })); },
    async link(input: CreateDocumentLinkRequest, key: string) { return documentLinkResultSchema.parse(await request('documents/links', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(createDocumentLinkRequestSchema.parse(input)) })); },
  };
}
export type ArchiveClient = ReturnType<typeof createArchiveClient>;
