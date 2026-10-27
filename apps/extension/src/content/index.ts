import { captureContentCommandSchema, captureAcquisitionCommandSchema } from '../archive/grants';
import { sendLocalResource } from '../archive/resources';
import { CaptureUnavailableError } from '../archive/collector';
import { errorMessage, type Result, type PageStatus } from '../shared/types';
import { contentCommandSchema, isTrustedExtensionSender } from '../shared/translation';
import { PageController } from './page-controller';
import { showSelectionPreview } from './selection';
import { wakeTranslation } from './background-translation';
import { contentAssistantSchema } from '../shared/assistant';
import { readArticle, revealArticleBlock } from '../assistant/article';

const scope = globalThis as typeof globalThis & { __pagelingo?: { dispose(): void } };

if (!scope.__pagelingo) {
  const controller = new PageController(document);
  let closeSelection: (() => void) | undefined;
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response: Result<PageStatus>) => void,
  ) => {
    if (!isTrustedExtensionSender(sender)) return;
    const acquisition = captureAcquisitionCommandSchema.safeParse(message);
    if (acquisition.success) {
      const command = acquisition.data;
      const respond = reply as (r: unknown) => void;
      void (async () => {
        if (command.type === 'capture:check-resource') {
          controller.captureResource(command.grant, command.resourceId);
          return { ok: true, value: controller.captureIdentity() };
        }
        if (command.type === 'capture:resource') {
          await sendLocalResource(command.grant, command.resourceId, (grant, id) => controller.captureResource(grant, id));
          return { ok: true };
        }
        let payload: unknown;
        try { payload = { ok: true, value: await controller.collectCapture(command.grant) }; }
        catch (error) {
          if (!(error instanceof CaptureUnavailableError)) throw error;
          payload = { ok: false, error: errorMessage(error), linkFallback: error.fallback };
        }
        return chrome.runtime.sendMessage({ type: 'capture:deliver', grant: command.grant, payload });
      })().then(respond, error => respond({ ok: false, error: errorMessage(error) }));
      return true;
    }
    const capture = captureContentCommandSchema.safeParse(message);
    if (capture.success) {
      const respond = reply as (r: unknown) => void;
      if (capture.data.type === 'capture:identity') {
        try { respond({ ok: true, value: controller.captureIdentity() }); }
        catch (error) { respond({ ok: false, error: errorMessage(error) }); }
        return;
      }
      void controller.collectCapture(capture.data.grant).then(value => respond({ ok: true, value }), error => respond({
        ok: false, error: errorMessage(error), ...(error instanceof CaptureUnavailableError ? { linkFallback: error.fallback } : {}),
      }));
      return true;
    }
    const assistant = contentAssistantSchema.safeParse(message);
    if (assistant.success) {
      try {
        const request = assistant.data;
        if (request.type === 'assistant:reveal') {
          revealArticleBlock(document, request.blockId, request.revision);
          (reply as (r: unknown) => void)({ ok: true, value: null });
        } else {
          const value = readArticle(document, request.includeSelection ? request.selectionText : '');
          (reply as (r: unknown) => void)({
            ok: true,
            value: { document: value.document, quote: request.includeSelection ? value.quote : undefined },
          });
        }
      } catch (error) {
        (reply as (r: unknown) => void)({ ok: false, error: errorMessage(error) });
      }
      return;
    }
    const wake = message as { type?: unknown; sessionId?: unknown } | null;
    if (wake?.type === 'translation:wakeup' && typeof wake.sessionId === 'string') {
      (reply as (r: unknown) => void)({ active: wakeTranslation(wake.sessionId) });
      return;
    }
    const parsed = contentCommandSchema.safeParse(message);
    if (!parsed.success) return;
    try {
      const { command, translationSessionId } = parsed.data;
      switch (command.type) {
        case 'page:preview':
          controller.start(command.mode);
          break;
        case 'page:translate':
          if (!translationSessionId) throw new Error('翻译任务缺少授权，请重新开始。');
          controller.start(command.mode, translationSessionId);
          break;
        case 'page:mode':
          controller.setMode(command.mode);
          break;
        case 'page:stop':
          controller.stop();
          break;
        case 'page:restore':
          controller.restore();
          closeSelection?.();
          break;
        case 'page:selection':
          if (!translationSessionId) throw new Error('翻译任务缺少授权，请重新开始。');
          closeSelection?.();
          closeSelection = showSelectionPreview(document, command.text, translationSessionId);
          break;
        case 'page:selection-preview':
          closeSelection?.();
          closeSelection = showSelectionPreview(document, command.text);
          break;
      }
      reply({ ok: true, value: controller.status });
    } catch (error) {
      reply({ ok: false, error: errorMessage(error) });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  scope.__pagelingo = {
    dispose() {
      controller.dispose();
      closeSelection?.();
      chrome.runtime.onMessage.removeListener(listener);
      delete scope.__pagelingo;
    },
  };
}
