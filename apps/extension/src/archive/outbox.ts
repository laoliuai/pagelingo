import { captureDraftSchema, createDocumentLinkRequestSchema, type CaptureDraft, type CreateDocumentLinkRequest } from '@pagelingo/document-contracts';
import { partition, sameBinding, type SiteBinding } from './binding.js';
import { ArchiveDatabase, type ArchiveEntry } from './database.js';
import { ArchiveHttpError, type ArchiveClient } from './client.js';
import { prepareCapture, type AcquiredResource } from './upload.js';
import type { CaptureGrant } from './grants.js';
class CapturePreparationCancelled extends Error {}
export interface OutboxDependencies {
  database: ArchiveDatabase; current(): Promise<SiteBinding | null>; client(binding: SiteBinding, signal: AbortSignal): ArchiveClient;
  acquire(draft: CaptureDraft, resourceId: string, entry: ArchiveEntry): Promise<AcquiredResource>;
  schedule?(when: number): Promise<void>; now?(): number;
}
export function createArchiveOutbox(deps: OutboxDependencies) {
  const db = deps.database; const now = deps.now ?? Date.now; let running: Promise<void> | undefined;
  async function assertCurrent(binding: SiteBinding) { if (!sameBinding(await deps.current(), binding)) throw new Error('站点连接已变化。'); }
  async function enqueueCapture(binding: SiteBinding, input: CaptureDraft, grant?: CaptureGrant, permission = false): Promise<string> {
    const draft = captureDraftSchema.parse(input); await assertCurrent(binding);
    if (await db.get(binding, draft.captureId)) throw new Error('采集已存在。');
    await db.put(binding, { id: draft.captureId, partition: partition(binding), kind: 'capture', state: permission ? 'permission' : 'pending', draft, grant, grantGeneration: binding.generation, resources: [], attempts: 0, nextAttemptAt: 0, createdAt: now(), warnings: [...draft.snapshot.warnings, ...draft.snapshot.scope.warnings] });
    await deps.schedule?.(now() + 2000); return draft.captureId;
  }
  async function enqueueLink(binding: SiteBinding, input: CreateDocumentLinkRequest, warnings: string[]): Promise<string> {
    const request = createDocumentLinkRequestSchema.parse(input); const id = crypto.randomUUID(); await assertCurrent(binding);
    await db.put(binding, { id, partition: partition(binding), kind: 'link', state: 'pending', linkRequest: request, resources: [], attempts: 0, nextAttemptAt: 0, createdAt: now(), warnings });
    await deps.schedule?.(now() + 2000); return id;
  }
  async function process(binding: SiteBinding, entry: ArchiveEntry, signal: AbortSignal) {
    const check = async () => { signal.throwIfAborted(); await assertCurrent(binding); };
    const client = deps.client(binding, signal);
    const cancelCapture = async (id: string) => {
      try { return await client.cancel(id); }
      catch (error) {
        if (!(error instanceof ArchiveHttpError) || error.code !== 'CAPTURE_COMPLETED') throw error;
        await check(); return client.status(id);
      }
    };
    try {
      await check();
      if (entry.kind === 'link') {
        if (entry.cancelRequested && !entry.linkAttempted) { entry.state = 'cancelled'; }
        else { entry.linkAttempted = true; await db.put(binding, entry); await check(); entry.linkResult = await client.link(entry.linkRequest!, entry.id); await check(); entry.state = 'completed'; }
      } else {
        let preparedHere = false;
        if (!entry.request && !entry.cancelRequested) {
          try {
            await prepareCapture(entry, binding, db, deps.acquire, async () => {
              await check();
              if ((await db.get(binding, entry.id))?.cancelRequested) throw new CapturePreparationCancelled();
            });
            preparedHere = true;
          } catch (error) {
            if (!(error instanceof CapturePreparationCancelled)) throw error;
            entry.cancelRequested = true; entry.request = undefined;
          }
        }
        await check(); entry.cancelRequested ||= (await db.get(binding, entry.id))?.cancelRequested;
        if (entry.cancelRequested && !entry.ingestionId && (preparedHere || !entry.request)) { entry.state = 'cancelled'; }
        else {
          // Recreate only when the initial ACK was lost: same persisted request and UUID key.
          let result = entry.ingestionId ? await client.status(entry.ingestionId) : await client.create(entry.request!, entry.id);
          await check();
          if (result.captureId !== entry.id || (entry.ingestionId && result.id !== entry.ingestionId)) throw new Error('站点返回的采集身份不一致。');
          entry.ingestionId = result.id; await db.put(binding, entry);
          entry.cancelRequested ||= (await db.get(binding, entry.id))?.cancelRequested;
          if (entry.cancelRequested && result.status !== 'completed') result = await cancelCapture(result.id);
          else if (!['completed', 'cancelled', 'failed'].includes(result.status)) {
            const files = await db.files(binding, entry.id);
            for (const id of result.missingFileIds) {
              await check(); const file = files.find(file => file.descriptor.id === id); if (!file) throw new Error('本地文件缺失。');
              await client.put(result.id, file.descriptor, file.bytes); await check();
            }
            for (let rebase = 0; ; rebase++) {
              await check();
              // An explicit cancellation may arrive while a file/commit request is in flight.
              if ((await db.get(binding, entry.id))?.cancelRequested) { entry.cancelRequested = true; result = await cancelCapture(result.id); break; }
              try { result = await client.commit(result.id); break; }
              catch (error) { if (!(error instanceof ArchiveHttpError) || error.code !== 'CAPTURE_REBASE_REQUIRED' || rebase >= 2) throw error; }
            }
          }
          await check(); entry.result = result;
          if (result.status === 'completed') entry.state = 'completed';
          else if (result.status === 'cancelled') entry.state = 'cancelled';
          else throw new Error(result.errorCode ?? '服务器尚未确认保存。');
        }
      }
      await check(); entry.error = undefined; await db.put(binding, entry);
    } catch (error) {
      if (!sameBinding(await deps.current(), binding) || signal.aborted) return;
      entry.attempts++; entry.error = error instanceof Error ? error.message : '上传失败。';
      entry.state = entry.attempts >= 5 || (error instanceof ArchiveHttpError && [400,401,403,409].includes(error.status)) ? 'manual' : 'retry';
      entry.nextAttemptAt = now() + Math.min(300000, 2000 * 2 ** (entry.attempts - 1));
      entry.cancelRequested ||= (await db.get(binding, entry.id))?.cancelRequested;
      await db.put(binding, entry); if (entry.state === 'retry') await deps.schedule?.(entry.nextAttemptAt);
    }
  }
  async function drainEntries(binding: SiteBinding, signal: AbortSignal): Promise<void> {
    await assertCurrent(binding);
    for (const entry of await db.list(binding)) {
      if (signal.aborted || !sameBinding(await deps.current(), binding)) return;
      if (['pending','retry'].includes(entry.state) && entry.nextAttemptAt <= now()) await process(binding, entry, signal);
    }
  }
  function serialized(operation: () => Promise<void>): Promise<void> {
    const run = (running ?? Promise.resolve()).catch(() => {}).then(operation);
    running = run;
    void run.finally(() => { if (running === run) running = undefined; }).catch(() => {});
    return run;
  }
  function drainOutbox(binding: SiteBinding, signal: AbortSignal): Promise<void> {
    return serialized(() => drainEntries(binding, signal));
  }
  function resumeOutbox(binding: SiteBinding, id?: string): Promise<void> {
    return serialized(async () => {
      await assertCurrent(binding);
      for (const entry of await db.list(binding)) if ((!id || entry.id === id) && ['pending','retry','manual', ...(id ? ['permission'] : [])].includes(entry.state)) {
        entry.state = 'pending'; entry.attempts = 0; entry.nextAttemptAt = 0; await db.put(binding, entry);
      }
      await drainEntries(binding, new AbortController().signal);
    });
  }
  async function cancel(binding: SiteBinding, id: string) {
    await assertCurrent(binding); await db.requestCancel(binding, id);
    await drainOutbox(binding, new AbortController().signal);
  }
  return { enqueueCapture, enqueueLink, drainOutbox, resumeOutbox, cancel };
}
