import { normalizeCaptureUrl } from '@pagelingo/web-capture';
import { z } from 'zod';
import { captureDraftSchema, captureUrlSchema, defaultCaptureLimits } from '@pagelingo/document-contracts';
import { isTrustedExtensionSender } from '../shared/translation';
import { readConnection, storeConnection, disconnectSite, sameBinding, hostPermission, type SiteBinding } from './binding';
import { exchangeSite, createArchiveClient } from './client';
import { ArchiveDatabase, type ArchiveEntry } from './database';
import { createArchiveOutbox } from './outbox';
import { captureGrantSchema, sameCaptureGrant, captureIdentitySchema, captureResourceFrameSchema, type CaptureGrant } from './grants';
import { acquireNetworkResource, decodeResourceFrame, validateNativeImage } from './resources';
import type { AcquiredResource } from './upload';

const commands = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('archive:status') }),
  z.strictObject({ type: z.literal('archive:pair'), origin: z.string().max(8192), code: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal('archive:disconnect') }),
  z.strictObject({ type: z.literal('archive:capture'), tabId: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('archive:retry'), id: z.uuid().optional() }),
  z.strictObject({ type: z.literal('archive:cancel'), id: z.uuid() }),
]);
const deliverySchema = z.strictObject({ type: z.literal('capture:deliver'), grant: captureGrantSchema,
  payload: z.union([
    z.strictObject({ ok: z.literal(true), value: captureDraftSchema }),
    z.strictObject({ ok: z.literal(false), error: z.string().max(4000), linkFallback: z.strictObject({ kind: z.literal('link-only'), url: captureUrlSchema, title: z.string().max(2000), warnings: z.array(z.string().min(1).max(4000)).max(1000) }) }),
  ]),
});
const ALARM = 'pagelingo-archive-outbox';
const db = new ArchiveDatabase();
const issued = new Map<string, { grant: CaptureGrant; binding: SiteBinding; expiresAt: number; consumed: boolean }>();
interface IncomingResource { bytes?: Uint8Array; received: number; mediaType?: string; total?: number }
const incoming = new Map<string, IncomingResource>();
let connectionEpoch = 0;
let connectionWrites: Promise<unknown> = Promise.resolve();
function writeConnection<T>(operation: () => Promise<T>): Promise<T> {
  const next = connectionWrites.then(operation, operation); connectionWrites = next.catch(() => {}); return next;
}
async function binding(): Promise<SiteBinding> { const c = await readConnection(); if (!c) throw new Error('请先在设置中连接资料站点。'); return c.binding; }
async function assertBinding(value: SiteBinding) { if (!sameBinding((await readConnection())?.binding ?? null, value)) throw new Error('站点连接已变化。'); }
async function schedule(when: number) {
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm || alarm.scheduledTime > when) await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 100, when) });
}
async function assertDocument(grant: CaptureGrant, resourceId?: string) {
  const tab = await chrome.tabs.get(grant.tabId);
  if (tab.url !== grant.url) throw new Error('页面已变化。');
  const [frame] = await chrome.scripting.executeScript({ target: { tabId: grant.tabId, frameIds: [0] }, func: () => null });
  if (frame?.documentId !== grant.documentId || frame.frameId !== 0) throw new Error('页面文档已变化。');
  const reply = await chrome.tabs.sendMessage(grant.tabId, resourceId ? { type: 'capture:check-resource', grant, resourceId } : { type: 'capture:identity' }, { documentId: grant.documentId, frameId: 0 });
  const identity = captureIdentitySchema.parse(reply?.ok ? reply.value : null);
  if (identity.contentSessionId !== grant.contentSessionId || identity.revision !== grant.revision || identity.url !== grant.url) throw new Error('页面原文已变化。');
}
function assertSender(sender: chrome.runtime.MessageSender, grant: CaptureGrant) {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== grant.tabId || sender.frameId !== 0 || sender.documentId !== grant.documentId || sender.url !== grant.url) throw new Error('采集消息来源不匹配。');
}
async function assertResourceGrant(entry: ArchiveEntry, current: SiteBinding, id: string) {
  if (!entry.grant || entry.grantGeneration !== current.generation || entry.createdAt + 5 * 60_000 < Date.now() || !entry.draft?.pendingResources.some(resource => resource.id === id)) throw new Error('采集资源授权已失效。');
  await assertBinding(current); await assertDocument(entry.grant, id); await assertBinding(current);
}
async function acquire(entry: ArchiveEntry, id: string): Promise<AcquiredResource> {
  const current = await binding(); await assertResourceGrant(entry, current, id);
  const resource = entry.draft!.pendingResources.find(resource => resource.id === id)!;
  let result: AcquiredResource;
  if (/^https?:/.test(resource.url)) result = await acquireNetworkResource(resource);
  else {
    const key = `${entry.grant!.grantId}/${id}`; const state: IncomingResource = { received: 0 }; incoming.set(key, state);
    try {
      const reply = await chrome.tabs.sendMessage(entry.grant!.tabId, { type: 'capture:resource', grant: entry.grant, resourceId: id }, { documentId: entry.grant!.documentId, frameId: 0 });
      if (!reply?.ok || !state.bytes || state.received !== state.total || !state.mediaType) throw new Error('unavailable');
      result = { bytes: state.bytes, mediaType: state.mediaType }; await validateNativeImage(result);
    } finally { incoming.delete(key); }
  }
  await assertResourceGrant(entry, current, id); return result;
}
const outbox = createArchiveOutbox({ database: db, current: async () => (await readConnection())?.binding ?? null,
  client: createArchiveClient, acquire: (_draft, id, entry) => acquire(entry, id), schedule });
async function permissionOrigins(entry: ArchiveEntry): Promise<string[]> {
  const origins = [...new Set(entry.draft?.pendingResources.filter(resource => resource.url.startsWith('https:')).map(resource => hostPermission(resource.url)) ?? [])];
  const missing: string[] = []; for (const origin of origins) if (!await chrome.permissions.contains({ origins: [origin] })) missing.push(origin); return missing;
}
async function receiveDelivery(message: z.infer<typeof deliverySchema>, sender: chrome.runtime.MessageSender) {
  const issuedGrant = issued.get(message.grant.grantId);
  if (!issuedGrant || issuedGrant.consumed || issuedGrant.expiresAt < Date.now() || !sameCaptureGrant(issuedGrant.grant, message.grant)) throw new Error('采集授权已使用或过期。');
  assertSender(sender, issuedGrant.grant);
  // Reserve synchronously: no second delivery may pass eligibility while validation yields.
  issuedGrant.consumed = true;
  await assertBinding(issuedGrant.binding); await assertDocument(issuedGrant.grant); await assertBinding(issuedGrant.binding);
  if (issuedGrant.expiresAt < Date.now()) throw new Error('采集授权已过期。');
  const payload = message.payload; let id: string;
  if (payload.ok) {
    if (payload.value.captureId !== message.grant.captureId || payload.value.snapshot.sourceUrl !== normalizeCaptureUrl(message.grant.url)) throw new Error('采集源身份不一致。');
    const required = await permissionOrigins({ draft: payload.value } as ArchiveEntry);
    await assertBinding(issuedGrant.binding);
    id = await outbox.enqueueCapture(issuedGrant.binding, payload.value, message.grant, required.length > 0);
  } else {
    if (payload.linkFallback.url !== normalizeCaptureUrl(message.grant.url)) throw new Error('链接来源不一致。');
    id = await outbox.enqueueLink(issuedGrant.binding, { url: payload.linkFallback.url, ...(payload.linkFallback.title ? { title: payload.linkFallback.title } : {}), translationIntent: 'auto' }, payload.linkFallback.warnings);
  }
  await assertBinding(issuedGrant.binding); void wakeArchive(); return { id, generation: issuedGrant.binding.generation };
}
async function receiveFrame(raw: unknown, sender: chrome.runtime.MessageSender) {
  const message = captureResourceFrameSchema.parse(raw); const current = await binding();
  assertSender(sender, message.grant);
  const entry = await db.get(current, message.grant.captureId);
  if (!entry?.grant || !sameCaptureGrant(entry.grant, message.grant)) throw new Error('资源授权不匹配。');
  await assertResourceGrant(entry, current, message.resourceId);
  const state = incoming.get(`${message.grant.grantId}/${message.resourceId}`);
  if (!state || state.received !== message.offset || (state.total !== undefined && state.total !== message.total) || (state.mediaType && state.mediaType !== message.mediaType)) throw new Error('资源帧顺序无效。');
  const bytes = decodeResourceFrame(message.data);
  if (message.offset + bytes.length > message.total) throw new Error('资源帧超过限制。');
  state.bytes ??= new Uint8Array(message.total); state.total = message.total; state.mediaType = message.mediaType;
  state.bytes.set(bytes, message.offset); state.received += bytes.length;
  await assertResourceGrant(entry, current, message.resourceId);
}
async function startCapture(tabId: number, ensureContent: (tabId: number) => Promise<void>) {
  const current = await binding(); await ensureContent(tabId);
  const tab = await chrome.tabs.get(tabId);
  const [frame] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => null });
  if (!frame?.documentId) throw new Error('无法确认页面身份。');
  const response = await chrome.tabs.sendMessage(tabId, { type: 'capture:identity' }, { documentId: frame.documentId, frameId: 0 });
  const identity = captureIdentitySchema.parse(response?.ok ? response.value : null);
  if (tab.url !== identity.url) throw new Error('页面地址已变化。');
  const grant: CaptureGrant = { ...identity, tabId, frameId: 0, documentId: frame.documentId, grantId: crypto.randomUUID(), captureId: crypto.randomUUID() };
  await assertBinding(current); await assertDocument(grant);
  for (const [id, value] of issued) if (value.expiresAt < Date.now() || value.consumed) issued.delete(id);
  if (issued.size >= 32) throw new Error('正在采集的页面过多。');
  issued.set(grant.grantId, { grant, binding: current, expiresAt: Date.now() + 30000, consumed: false });
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'capture:begin', grant }, { documentId: grant.documentId, frameId: 0 });
    await assertBinding(current); if (!result?.ok) throw new Error(result?.error ?? '采集失败。'); return result.value;
  } finally { issued.delete(grant.grantId); }
}
async function status() {
  const connection = await readConnection(); if (!connection) return { binding: null, username: null, items: [] };
  const current = connection.binding; const items = [];
  for (const entry of (await db.list(current)).sort((a,b) => b.createdAt - a.createdAt)) items.push({
    id: entry.id, title: entry.draft?.metadata.title ?? entry.linkRequest?.title ?? entry.linkRequest?.url, state: entry.state,
    kind: entry.kind, saveStatus: entry.result?.status === 'completed' ? entry.result.saveStatus : entry.linkResult ? 'link-only' : null,
    warnings: [...entry.warnings, ...(entry.result?.warnings ?? [])], error: entry.error, completeWithinScope: entry.draft?.snapshot.scope.completeWithinScope ?? null,
    permissionOrigins: entry.state === 'permission' ? await permissionOrigins(entry) : [],
  });
  await assertBinding(current); return { binding: current, username: connection.username, items };
}
export async function wakeArchive(): Promise<void> {
  try {
    const current = await binding(); await outbox.drainOutbox(current, new AbortController().signal);
    for (const entry of await db.list(current)) if (['pending','retry'].includes(entry.state)) await schedule(entry.nextAttemptAt || Date.now() + 2000);
  } catch { /* Startup does not prompt for permissions or access another partition. */ }
}
export function handleArchiveRequest(raw: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void, ensureContent: (tabId: number) => Promise<void>): boolean {
  const type = (raw as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !(type.startsWith('archive:') || ['capture:deliver','capture:resource-frame'].includes(type))) return false;
  const run = async () => {
    // Reject non-JSON and oversized messages before parsing/copying nested drafts.
    const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (bytes > defaultCaptureLimits.maxIrBytes) throw new Error('采集消息超过限制。');
    if (type === 'capture:deliver') return receiveDelivery(deliverySchema.parse(raw), sender);
    if (type === 'capture:resource-frame') { await receiveFrame(raw, sender); return null; }
    if (!isTrustedExtensionSender(sender)) throw new Error('仅扩展页面可以操作资料站点。');
    const command = commands.parse(raw);
    if (command.type === 'archive:status') return status();
    if (command.type === 'archive:pair') {
      const epoch = ++connectionEpoch; const result = await exchangeSite(command.origin, command.code);
      if (epoch !== connectionEpoch) throw new Error('站点连接已变化。');
      const connected = await writeConnection(async () => {
        if (epoch !== connectionEpoch) throw new Error('站点连接已变化。');
        return storeConnection(command.origin, result);
      }); issued.clear();
      if (epoch !== connectionEpoch) throw new Error('站点连接已变化。');
      void wakeArchive(); return { binding: connected.binding, username: connected.username };
    }
    if (command.type === 'archive:disconnect') { connectionEpoch++; issued.clear(); await writeConnection(disconnectSite); return null; }
    if (command.type === 'archive:capture') return startCapture(command.tabId, ensureContent);
    const current = await binding();
    if (command.type === 'archive:cancel') void outbox.cancel(current, command.id).catch(() => {});
    else void outbox.resumeOutbox(current, command.id).catch(() => {});
    return { generation: current.generation };
  };
  void run().then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error instanceof Error ? error.message : '资料操作失败。' }));
  return true;
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void wakeArchive(); });
