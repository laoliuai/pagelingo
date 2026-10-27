import type { TranslationBatchResult, TranslationDocument } from '@pagelingo/translation-core';
import { TRANSLATION_PORT, translationEventSchema, type TranslationEvent, type TranslationProvenance } from '../shared/translation';

const connections = new Map<string, () => void>();
export function wakeTranslation(sessionId: string): boolean {
  const reconnect = connections.get(sessionId); reconnect?.(); return Boolean(reconnect);
}

/** Reconnect only after the page confirms its current source snapshot. */
export async function* translateInBackground(document: TranslationDocument, sessionId: string, signal: AbortSignal,
  hooks: { isCurrent?: () => boolean; onRecover?: () => void; onProvenance?: (value: TranslationProvenance) => void } = {}): AsyncGenerator<TranslationBatchResult> {
  signal.throwIfAborted();
  const cancel = () => { void chrome.runtime.sendMessage({ type: 'translation:cancel', sessionId }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true }); let reconnects = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      if (hooks.isCurrent && !hooks.isCurrent()) throw new Error('页面正文已变化，无法接续旧翻译。');
      const port = chrome.runtime.connect({ name: TRANSLATION_PORT });
      const events: TranslationEvent[] = []; let disconnected = false; let wake: (() => void) | undefined; let failure: Error | undefined;
      const onMessage = (value: unknown) => {
        const parsed = translationEventSchema.safeParse(value);
        if (!parsed.success) failure = new Error('翻译后台返回了无效消息，请重新开始。');
        else if (parsed.data.type !== 'translation:heartbeat') events.push(parsed.data);
        wake?.();
      };
      const onDisconnect = () => { void chrome.runtime.lastError; disconnected = true; wake?.(); };
      const onAbort = () => { port.disconnect(); wake?.(); };
      const pulse = setInterval(() => { if (!disconnected) { try { port.postMessage({ type: 'translation:heartbeat' }); } catch { onDisconnect(); } } }, 15000);
      connections.set(sessionId, () => { port.disconnect(); onDisconnect(); });
      port.onMessage.addListener(onMessage); port.onDisconnect.addListener(onDisconnect); signal.addEventListener('abort', onAbort, { once: true });
      try {
        port.postMessage({ type: 'translation:start', sessionId, document, resume: reconnects > 0 });
        while (true) {
          signal.throwIfAborted(); if (failure) throw failure;
          const event = events.shift();
          if (!event) { if (disconnected) break; await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined; continue; }
          if (event.type === 'translation:provenance') { hooks.onProvenance?.(event.value); continue; }
          if (event.type === 'translation:error') throw new Error(event.error);
          if (event.type === 'translation:done') return;
          if (event.type !== 'translation:batch') continue;
          if (event.value.documentId !== document.id) throw new Error('翻译结果不属于当前页面。');
          yield event.value; signal.throwIfAborted();
          if (!disconnected) { try { port.postMessage({ type: 'translation:continue' }); } catch { onDisconnect(); } }
        }
      } finally {
        clearInterval(pulse); connections.delete(sessionId); signal.removeEventListener('abort', onAbort);
        port.onMessage.removeListener(onMessage); port.onDisconnect.removeListener(onDisconnect); port.disconnect();
      }
      if (++reconnects > 6) throw new Error('后台多次中断，已完成译文保留；请重新翻译以接续缓存结果。');
      hooks.onRecover?.();
      await new Promise<void>((resolve, reject) => {
        const stopped = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve(); }, Math.min(250 * 2 ** (reconnects - 1), 5000));
        signal.addEventListener('abort', stopped, { once: true });
      });
    }
  } finally { connections.delete(sessionId); signal.removeEventListener('abort', cancel); }
}
