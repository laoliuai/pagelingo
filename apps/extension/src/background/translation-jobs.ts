import { ConcurrencyScheduler, TranslationEngine, contentHash, documentFingerprint, normalizeDocumentUrl, CheckpointConflictError } from '@pagelingo/translation-core';
import { createProvider, providerIdentity, requireApiPermission } from '../settings/connection';
import { readSettings } from '../settings/storage';
import type { UserSettings } from '../settings/schema';
import { errorMessage } from '../shared/types';
import { TRANSLATION_PORT, translationStartSchema, type TranslationEvent } from '../shared/translation';
import { TranslationDatabase, type JobRecord } from './database';
import { recoveryAlarmMode } from './job-policy';

export const database = new TranslationDatabase();
export const scheduler = new ConcurrencyScheduler(2);
const owner = crypto.randomUUID();
const active = new Map<string, AbortController>();
const ALARM = 'pagelingo-recovery';
const budget = (s: UserSettings) => ({ maxInputTokens: s.maxInputTokens, maxOutputTokens: s.maxOutputTokens,
  contextWindowTokens: s.contextWindowTokens, maxBatchBlocks: 4, reserveTokens: 512 });
const signature = (s: UserSettings) => contentHash({ identity: providerIdentity(s), budget: budget(s), targetLanguage: s.targetLanguage, profile: 'technical',
  glossary: s.customGlossary, glossaryDomain: s.glossaryDomain });

async function updateAlarm(): Promise<void> {
  const mode = recoveryAlarmMode(await database.listJobs());
  const alarm = await chrome.alarms.get(ALARM);
  if (mode === 'active') {
    if (!alarm?.periodInMinutes) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  } else if (mode === 'confirm') {
    if (!alarm || alarm.periodInMinutes) await chrome.alarms.create(ALARM, { delayInMinutes: 0.5 });
  } else await chrome.alarms.clear(ALARM);
}
const ready = (async () => {
  const settings = await readSettings();
  database.setMaxBytes(settings.cacheMaxMiB * 1024 * 1024);
  for (const job of await database.listJobs()) {
    if (job.checkpoint?.nextRequestAt) scheduler.deferUntil(providerIdentity(job.settings as UserSettings).endpoint, job.checkpoint.nextRequestAt);
    if (job.status === 'running' && job.owner !== owner) {
      await database.updateJob(job.id, job.epoch, { status: 'paused', epoch: job.epoch + 1 }).catch(() => {});
    }
  }
  await updateAlarm();
})().catch(() => {});

export async function wakeTranslationJobs(): Promise<void> {
  await ready;
  for (const job of await database.listJobs()) if (job.status === 'paused') {
    await chrome.tabs.sendMessage(job.tabId, { type: 'translation:wakeup', sessionId: job.id }, { frameId: 0 }).catch(() => undefined);
  }
  await updateAlarm();
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void wakeTranslationJobs(); });

/** Persistent one-use grant; only the UUID capability reaches a content script. */
export async function issueTranslationGrant(tabId: number): Promise<string> {
  await ready;
  const settings = await readSettings(); await requireApiPermission(settings); createProvider(settings);
  const { apiKey: _key, ...publicSettings } = settings;
  database.setMaxBytes(settings.cacheMaxMiB * 1024 * 1024);
  const id = crypto.randomUUID();
  await database.putJob({ id, tabId, settings: publicSettings, configSignature: await signature(settings),
    status: 'granted', epoch: 0, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 30000 });
  return id;
}
export function revokeTranslationGrant(id: string): void { void database.cancelJob(id); }

function validSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0 && Boolean(sender.documentId) && /^https?:\/\//.test(sender.url ?? '');
}
export async function cancelTranslationSession(id: string, sender: chrome.runtime.MessageSender): Promise<void> {
  if (!validSender(sender)) return;
  const job = await database.getJob(id);
  if (!job || job.tabId !== sender.tab!.id || (job.documentId && job.documentId !== sender.documentId)) return;
  await database.cancelJob(id); active.get(id)?.abort(); await updateAlarm();
}

export function connectTranslation(port: chrome.runtime.Port): void {
  if (port.name !== TRANSLATION_PORT) return;
  const sender = port.sender;
  if (!sender || !validSender(sender)) { port.disconnect(); return; }
  const abort = new AbortController(); let connected = true; let started = false; let finished = false;
  let job: JobRecord | undefined; let ownsJob = false; let continueBatch: (() => void) | undefined;
  const post = (event: TranslationEvent) => { if (connected) { try { port.postMessage(event); } catch { abort.abort(); } } };
  const timeout = setTimeout(() => { post({ type: 'translation:error', error: '翻译任务未启动，请重新开始。' }); port.disconnect(); }, 5000);
  const heartbeat = setInterval(() => { if (started && !finished) post({ type: 'translation:heartbeat' }); }, 15000);
  port.onDisconnect.addListener(() => { connected = false; clearTimeout(timeout); clearInterval(heartbeat); abort.abort(); continueBatch?.(); });
  port.onMessage.addListener((value: unknown) => {
    if (started) { if ((value as { type?: unknown } | null)?.type === 'translation:continue') continueBatch?.(); return; }
    started = true; clearTimeout(timeout);
    void (async () => {
      await ready;
      if (JSON.stringify(value).length > 2000000) throw new Error('页面文本过多，请先翻译选中内容。');
      const parsed = translationStartSchema.safeParse(value);
      if (!parsed.success) throw new Error('翻译任务格式不正确，请重新开始。');
      const message = parsed.data;
      job = await database.getJob(message.sessionId);
      if (!job || job.tabId !== sender.tab!.id || ['cancelled', 'failed', 'superseded'].includes(job.status)) throw new Error('翻译任务未获授权或已失效，请从扩展重新开始。');
      const settings = await readSettings(); await requireApiPermission(settings);
      database.setMaxBytes(settings.cacheMaxMiB * 1024 * 1024);
      if (job.configSignature !== await signature(settings)) throw new Error('翻译配置已变化，请从扩展重新开始。');
      const fingerprint = await documentFingerprint(message.document); const url = normalizeDocumentUrl(sender.url!);
      if (message.resume) {
        if (job.documentId !== sender.documentId || job.pageSessionId !== message.document.id || job.fingerprint !== fingerprint || job.url !== url || active.has(job.id)) throw new Error('页面会话或正文已变化，无法接续旧任务。');
      } else {
        if (job.status !== 'granted' || job.expiresAt < Date.now()) throw new Error('翻译任务未获授权或已过期，请从扩展重新开始。');
        const previous = (await database.listJobs()).filter((candidate) => candidate.id !== job!.id && candidate.status === 'paused' && !active.has(candidate.id) &&
          candidate.fingerprint === fingerprint && candidate.url === url && candidate.configSignature === job!.configSignature).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (previous) { await database.updateJob(previous.id, previous.epoch, { status: 'superseded', epoch: previous.epoch + 1 }); job.checkpoint = previous.checkpoint; }
      }
      abort.signal.throwIfAborted();
      job = await database.updateJob(job.id, job.epoch, { status: 'running', epoch: job.epoch + 1, owner,
        documentId: sender.documentId, pageSessionId: message.document.id, fingerprint, url,
        document: message.document, checkpoint: job.checkpoint });
      ownsJob = true;
      active.set(job.id, abort); await updateAlarm();
      const engine = new TranslationEngine(createProvider(settings), { reliability: {
        identity: providerIdentity(settings), budget: budget(settings), cache: database,
        state: database.stateStore(job.id, job.epoch), scheduler,
      } });
      for await (const batch of engine.translate(message.document, { targetLanguage: settings.targetLanguage, signal: abort.signal,
        glossary: settings.customGlossary, glossaryDomain: settings.glossaryDomain })) {
        abort.signal.throwIfAborted(); const stats = await database.stats();
        if (stats.warning && batch.metrics) batch.metrics.storageWarning = stats.warning;
        const consumed = new Promise<void>((resolve) => { continueBatch = () => { continueBatch = undefined; resolve(); }; });
        post({ type: 'translation:batch', value: batch }); await consumed; abort.signal.throwIfAborted();
      }
      await database.updateJob(job.id, job.epoch, { status: 'completed' }); finished = true; post({ type: 'translation:done' });
    })().catch(async (error: unknown) => {
      if (!abort.signal.aborted && !(error instanceof CheckpointConflictError)) {
        post({ type: 'translation:error', error: errorMessage(error) });
        if (ownsJob && job?.status === 'running') await database.updateJob(job.id, job.epoch, { status: 'failed' }).catch(() => {});
      } else if (ownsJob && job?.status === 'running') await database.updateJob(job.id, job.epoch, { status: 'paused', epoch: job.epoch + 1 }).catch(() => {});
    }).finally(() => {
      finished = true; clearInterval(heartbeat); if (job && active.get(job.id) === abort) active.delete(job.id); void updateAlarm();
    });
  });
}
