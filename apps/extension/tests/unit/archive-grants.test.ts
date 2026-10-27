import { afterEach, expect, it, vi } from 'vitest';
import { PageController } from '../../src/content/page-controller';
import { PROMPT_VERSION, PROTECTION_VERSION } from '@pagelingo/translation-core';
const controllers: PageController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.unstubAllGlobals(); });
function setup() {
  document.body.innerHTML = '<article><p>This original source is ready for translation.</p><img src="https://example.org/image.png"></article>';
  document.documentElement.lang = 'en';
  const controller = new PageController(document); controllers.push(controller);
  const grant = { ...controller.captureIdentity(), grantId: crypto.randomUUID(), captureId: crypto.randomUUID(), tabId: 9, frameId: 0 as const, documentId: 'chrome-document' };
  return { controller, grant };
}
it('consumes trusted grants once and rejects document, URL, revision and frame substitution', async () => {
  const { controller, grant } = setup();
  await expect(controller.collectCapture({ ...grant, contentSessionId: crypto.randomUUID() })).rejects.toThrow(/stale/i);
  await expect(controller.collectCapture({ ...grant, url: 'https://attacker.example/' })).rejects.toThrow(/stale/i);
  await expect(controller.collectCapture({ ...grant, revision: grant.revision + 1 })).rejects.toThrow(/stale/i);
  await expect(controller.collectCapture({ ...grant, frameId: 1 } as never)).rejects.toThrow();
  const draft = await controller.collectCapture(grant);
  await expect(controller.collectCapture(grant)).rejects.toThrow(/consumed/);
  expect(controller.captureResource(grant, draft.pendingResources[0]!.id).url).toBe('https://example.org/image.png');
  expect(() => controller.captureResource(grant, 'forged')).toThrow(/resource/i);
  expect(() => controller.captureResource({ ...grant, documentId: 'another' }, draft.pendingResources[0]!.id)).toThrow(/grant/i);
  document.querySelector('img')!.src = 'https://example.org/new.png';
  expect(() => controller.captureResource(grant, draft.pendingResources[0]!.id)).toThrow(/stale|changed/i);
});
it('uses trusted translation provenance and actual settled SDK text for imported candidates', async () => {
  const { controller } = setup();
  const listeners = new Set<(message: unknown) => void>();
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => {}, connect: () => ({
    onMessage: { addListener: (listener: (value: unknown) => void) => listeners.add(listener), removeListener: (listener: (value: unknown) => void) => listeners.delete(listener) },
    onDisconnect: { addListener: () => {}, removeListener: () => {} }, disconnect: () => {},
    postMessage(message: { type: string; document?: { id: string; blocks: { id: string }[] } }) {
      if (message.type !== 'translation:start') return;
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ type: 'translation:provenance', value: { sdkVersion: '0.4.0', promptVersion: PROMPT_VERSION, protectionVersion: PROTECTION_VERSION, sourceLanguage: 'en', targetLanguage: 'zh-CN' } });
          listener({ type: 'translation:batch', value: { documentId: message.document!.id, completed: 1, total: 1, translations: [{ id: message.document!.blocks[0]!.id, text: '可信的完整译文。', content: [{ type: 'text', text: '可信的完整译文。' }] }] } });
          listener({ type: 'translation:done' });
        }
      });
    },
  }) } });
  controller.start('translation', crypto.randomUUID());
  await expect.poll(() => controller.status.status).toBe('completed');
  const grant = { ...controller.captureIdentity(), grantId: crypto.randomUUID(), captureId: crypto.randomUUID(), tabId: 9, frameId: 0 as const, documentId: 'chrome-document' };
  const draft = await controller.collectCapture(grant);
  expect(draft.existingTranslation?.targetLanguage).toBe('zh-CN');
  expect(draft.existingTranslation?.blocks[0]?.rawText).toBe('可信的完整译文。');
});
it('does not export mock preview results as existing translations', async () => {
  const { controller } = setup();
  controller.start('bilingual');
  await expect.poll(() => controller.status.status).toBe('completed');
  const grant = { ...controller.captureIdentity(), grantId: crypto.randomUUID(), captureId: crypto.randomUUID(), tabId: 9, frameId: 0 as const, documentId: 'chrome-document' };
  expect((await controller.collectCapture(grant)).existingTranslation).toBeNull();
});
