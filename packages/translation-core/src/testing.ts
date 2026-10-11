import type { GenerationRequest, TranslationProvider } from './provider.js';
import type { TranslationOutput } from './types.js';

/** Local preview only. Deliberately exported separately from the production API. */
export class MockProvider implements TranslationProvider {
  constructor(private readonly delayMs = 80) {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs 必须是非负数。');
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<TranslationOutput> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    signal.throwIfAborted();
    return { translations: request.data.blocks.map((input) => ({ id: input.id, text: `【布局预览】${input.protectedText}` })) };
  }
}
