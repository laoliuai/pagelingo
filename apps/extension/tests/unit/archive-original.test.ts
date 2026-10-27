import { afterEach, describe, expect, it } from 'vitest';
import { collectOriginalCapture } from '../../src/archive/collector';
import { PageController } from '../../src/content/page-controller';

const captureId = 'a90c086e-f741-4e18-8192-cb6da71f523c';
const controllers: PageController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); });
function source(html: string) {
  document.body.innerHTML = html;
  document.title = 'Original article';
}

describe('original archive', () => {
  it('captures identical source through all live translation modes without mutating the page', async () => {
    source('<article><p>This original paragraph explains a useful browser feature.</p><p>Repeated original paragraph.</p><p>Repeated original paragraph.</p></article>');
    const controller = new PageController(document); controllers.push(controller);
    const original = (await collectOriginalCapture(document, { captureId })).snapshot.html;
    controller.start('bilingual');
    await expect.poll(() => controller.status.status).toBe('completed');
    const saved: string[] = [];
    for (const mode of ['source', 'translation', 'bilingual'] as const) {
      controller.setMode(mode);
      const live = document.body.innerHTML;
      const draft = await collectOriginalCapture(document, { captureId });
      saved.push(draft.snapshot.html);
      expect(document.body.innerHTML).toBe(live);
      expect(new Set(draft.snapshot.nodeIds).size).toBe(draft.snapshot.nodeIds.length);
    }
    expect(saved).toEqual([original, original, original]);
  });

  it('excludes extension UI, form state, hidden application data and scripts', async () => {
    source('<article><p>Public text.</p><div data-pl-owned>API secret</div><form><input value="password"><textarea>form secret</textarea></form><script>settings = "secret"</script><div hidden>hidden state</div></article>');
    const draft = await collectOriginalCapture(document, { captureId });
    expect(draft.snapshot.html).toContain('Public text.');
    expect(draft.snapshot.html).not.toMatch(/secret|password|hidden state|data-pl-owned|<script|<form|<input/);
  });

  it('aborts a capture when source changes while asynchronous work is pending', async () => {
    source('<article><p>Original text.</p></article>');
    const controller = new PageController(document); controllers.push(controller);
    const identity = controller.captureIdentity();
    const pending = controller.collectCapture({ ...identity, captureId, grantId: crypto.randomUUID(), tabId: 1, frameId: 0, documentId: 'chrome-document' });
    document.querySelector('p')!.textContent = 'Changed source';
    await expect(pending).rejects.toThrow(/changed|stale/i);
  });
});
it('fences direct collector callers when a source image changes during hashing', async () => {
  source('<article><p>Original text.</p><img src="https://example.org/first.png"></article>');
  const pending = collectOriginalCapture(document, { captureId });
  document.querySelector('img')!.src = 'https://example.org/second.png';
  await expect(pending).rejects.toThrow(/changed|stale/i);
});
