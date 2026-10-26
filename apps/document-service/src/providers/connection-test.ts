import { OpenAICompatibleProvider, buildTranslationRequest, validateBatch } from '@pagelingo/translation-core';
import type { TranslationInput } from '@pagelingo/translation-core';
import type { ProviderTestResult } from '@pagelingo/document-contracts';
import { assertActorCurrent } from '../auth/guards.js';
import type { Actor } from '../auth/guards.js';
import { consumeRateLimit } from '../auth/rate-limit.js';
import type { Database } from '../db/database.js';
import { ServiceError } from '../errors.js';
import type { createProvidersService } from './service.js';
import { findProviderProfile } from './repository.js';

const blocks: TranslationInput[] = [{ id: 'connection-test', kind: 'paragraph', sourceText: 'Hello.', protectedText: 'Hello.', slots: [] }];
const request = buildTranslationRequest({ id: 'connection-test', sourceLanguage: 'en' }, blocks, 'zh-CN', 'technical');

// PostgreSQL work may finish after cancellation; never let it delay the caller or start egress.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

export function createConnectionTestService({ db, providers, outboundFetch }: {
  db: Database; providers: ReturnType<typeof createProvidersService>; outboundFetch: typeof fetch;
}) {
  return {
    async testProviderConnection(actor: Actor, signal?: AbortSignal): Promise<ProviderTestResult> {
      const controller = new AbortController();
      const cancelled = () => controller.abort(new ServiceError(499, 'REQUEST_CANCELLED', 'Request cancelled'));
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
      const deadline = setTimeout(() => controller.abort(new ServiceError(504, 'PROVIDER_TIMEOUT', 'Provider test timed out')), 10_000);
      let poll: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let monitorCheck: Promise<void> | undefined;
      try {
        controller.signal.throwIfAborted();
        const { profile, apiKey } = await abortable(providers.getForCall(actor), controller.signal);
        if (!profile.baseUrl || !profile.model || !apiKey) throw new ServiceError(400, 'PROVIDER_INCOMPLETE', 'Complete provider settings before testing');
        const check = () => db.transaction(async client => {
          await assertActorCurrent(client, actor);
          if ((await findProviderProfile(client, actor.userId))?.revision !== profile.revision) {
            throw new ServiceError(409, 'REVISION_CONFLICT', 'Provider profile has changed');
          }
        });
        // Commit the guarded quota before network I/O, including failed attempts.
        await abortable(db.transaction(async client => {
          await assertActorCurrent(client, actor);
          if ((await findProviderProfile(client, actor.userId))?.revision !== profile.revision) {
            throw new ServiceError(409, 'REVISION_CONFLICT', 'Provider profile has changed');
          }
          controller.signal.throwIfAborted();
          await consumeRateLimit(client, { scope: 'provider-test', subject: actor.userId, limit: 5, windowSeconds: 60 });
          controller.signal.throwIfAborted();
        }), controller.signal);
        const monitor = async () => {
          try { monitorCheck = check(); await monitorCheck; }
          catch (error) { controller.abort(error instanceof ServiceError ? error : new ServiceError(503, 'PROVIDER_TEST_UNAVAILABLE', 'Provider test unavailable')); }
          finally { monitorCheck = undefined; }
          if (!stopped && !controller.signal.aborted) poll = setTimeout(() => { void monitor(); }, 100);
        };
        poll = setTimeout(() => { void monitor(); }, 100);
        const provider = new OpenAICompatibleProvider({ baseUrl: profile.baseUrl, model: profile.model, apiKey,
          temperature: profile.temperature, responseFormat: profile.responseFormat,
          maxOutputTokens: Math.min(128, profile.maxOutputTokens), maxTokensParameter: profile.maxTokensParameter,
          thinking: profile.thinkingMode === 'disabled' ? 'disabled' : undefined, stream: profile.stream,
          timeoutMs: 10_000, fetch: outboundFetch,
        });
        // Direct Provider invocation has no retry layer (equivalent to maxRetries=0).
        controller.signal.throwIfAborted();
        const result = await provider.generateDetailed(request, controller.signal);
        validateBatch(blocks, result.output);
        stopped = true; clearTimeout(poll);
        if (monitorCheck) await abortable(monitorCheck, controller.signal);
        await abortable(check(), controller.signal);
        controller.signal.throwIfAborted();
        return { ok: true, profileRevision: profile.revision, ...(result.usage ? { usage: result.usage } : {}), checkedAt: new Date().toISOString() };
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof ServiceError) throw controller.signal.reason;
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(502, 'PROVIDER_TEST_FAILED', 'Provider connection test failed');
      } finally {
        stopped = true; clearTimeout(deadline); clearTimeout(poll);
        signal?.removeEventListener('abort', cancelled);
        controller.abort();
      }
    },
  };
}
