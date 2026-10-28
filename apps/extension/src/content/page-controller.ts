import type { PendingCaptureResource } from '@pagelingo/document-contracts';
import type { TranslationProvenance } from '../shared/translation';
import type { ExistingTranslationEvidence } from '../archive/existing-translations';
import { collectOriginalCapture } from '../archive/collector';
import { fitCaptureDelivery } from '../archive/delivery-budget';
import { captureGrantSchema, type CaptureGrant, type CaptureIdentity } from '../archive/grants';
import { originalTree, selectArchiveSource, originalSourceSignature } from '../archive/original-tree';
import { extractBlocks, extractBlocksSync } from '../dom/extractor';
import { DomRenderer } from '../dom/renderer';
import { blockDocumentVersion, sourceChangeReason, sourceDocumentVersion, translationTitle } from '../dom/document-version';
import { findContentScope } from '../dom/content-scope';
import type { ProtectedBlock } from '../dom/protect';
import { TranslationEngine } from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';
import { errorMessage, type DisplayMode, type PageStatus } from '../shared/types';
import { translateInBackground } from './background-translation';

export class PageController {
  private readonly captureSessionId = crypto.randomUUID();
  private captureRevision = 0;
  private captureGeneration = 0;
  private captureSource = '';
  private readonly consumedCaptureGrants = new Set<string>();
  private disposed = false;
  private capturedResources?: { grant: CaptureGrant; resources: ReadonlyMap<string, PendingCaptureResource> };
  private translationProvenance?: TranslationProvenance;
  private renderer = new DomRenderer();
  private engine = new TranslationEngine(new MockProvider());
  private blocks: ProtectedBlock[] = [];
  private abort?: AbortController;
  private observer: MutationObserver;
  private revision = 0;
  private url: string;
  private sourceVersion?: string;
  private blockVersion?: string;
  private sourceTitle = '';
  private sourceLanguage = '';
  private usesDocumentTitle = true;
  private byId = new Map<string, ProtectedBlock>();
  private translated = new Map<string, string>();
  private interval: ReturnType<typeof setInterval>;
  private state: PageStatus = {
    pageSessionId: crypto.randomUUID(), status: 'idle', mode: 'bilingual', execution: 'preview', total: 0, completed: 0, failed: 0, fallback: 0, recoveries: 0,
  };

  constructor(private document: Document) {
    this.url = this.navigationKey();
    this.observer = new MutationObserver((records) => {
      if (!this.sourceVersion) return;
      const changed = records.some((record) => {
        const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement;
        if (element?.closest('[data-pl-owned]')) return false;
        if (element?.closest('title')) return this.usesDocumentTitle;
        // Even sibling changes outside the article can affect source visibility
        // through CSS :has(), :empty or sibling selectors.
        return true;
      });
      if (changed) this.isCurrentSource();
    });
    this.observe();
    // Poll the shared URL instead of patching the page's History API from an isolated world.
    // The timer is attached to this document and disappears when the document unloads.
    this.interval = setInterval(() => {
      if (this.navigationKey() !== this.url) {
        this.restore();
        this.url = this.navigationKey();
      }
    }, 500);
  }

  get status(): PageStatus {
    return { ...this.state, fallback: this.renderer.fallbackCount };
  }

  /** Read-only source identity; does not restore or toggle live translation state. */
  captureIdentity(): CaptureIdentity {
    if (this.disposed) throw new Error('Capture document is disposed');
    const source = selectArchiveSource(this.document);
    const tree = originalTree(this.document, source);
    const fingerprint = originalSourceSignature(this.document, source, tree);
    if (fingerprint !== this.captureSource) { this.captureRevision++; this.captureSource = fingerprint; }
    return { contentSessionId: this.captureSessionId, revision: this.captureRevision, url: this.document.URL };
  }

  async collectCapture(input: CaptureGrant) {
    const grant = captureGrantSchema.parse(input);
    if (this.document.defaultView && this.document.defaultView.top !== this.document.defaultView) throw new Error('Only frame 0 may capture');
    if (this.consumedCaptureGrants.has(grant.grantId)) throw new Error('Capture grant already consumed');
    const assertSource = () => {
      const current = this.captureIdentity();
      if (current.contentSessionId !== grant.contentSessionId || current.revision !== grant.revision || current.url !== grant.url) throw new Error('Capture source changed; stale grant');
    };
    assertSource();
    // Bound lifetime memory. A document that exhausts grants must be reloaded,
    // rather than forgetting consumed capabilities and accepting a replay.
    if (this.consumedCaptureGrants.size >= 256) throw new Error('Capture grant limit reached; reload this document');
    this.consumedCaptureGrants.add(grant.grantId);
    const generation = ++this.captureGeneration;
    const assertCurrent = () => {
      if (generation !== this.captureGeneration) throw new Error('Capture grant superseded by a newer collection');
      assertSource();
    };
    this.capturedResources = undefined;
    const draft = fitCaptureDelivery(grant, await collectOriginalCapture(this.document, { captureId: grant.captureId, assertCurrent, translations: this.captureTranslations() }));
    assertCurrent();
    this.capturedResources = { grant, resources: new Map(draft.pendingResources.map(resource => [resource.id, structuredClone(resource)])) };
    return draft;
  }

  /** Task8 local acquisition must select a recorded resource, never an arbitrary supplied URL. */
  captureResource(input: CaptureGrant, resourceId: string): PendingCaptureResource {
    const grant = captureGrantSchema.parse(input);
    const captured = this.capturedResources;
    if (!captured || JSON.stringify(captured.grant) !== JSON.stringify(grant)) throw new Error('Capture resource grant mismatch');
    const current = this.captureIdentity();
    if (current.contentSessionId !== grant.contentSessionId || current.revision !== grant.revision || current.url !== grant.url) throw new Error('Capture source changed; stale resource grant');
    const resource = captured.resources.get(resourceId);
    if (!resource) throw new Error('Resource was not selected by this capture');
    return structuredClone(resource);
  }

  private captureTranslations(): ExistingTranslationEvidence | undefined {
    if (this.state.execution !== 'translation' || !this.translationProvenance || !this.sourceVersion
      || sourceDocumentVersion(this.document) !== this.sourceVersion) return undefined;
    const blocks = this.blocks.flatMap(block => {
      const rawText = this.translated.get(block.block.id);
      return rawText !== undefined && this.renderer.isCurrent(block) ? [{ source: structuredClone(block.block), rawText }] : [];
    });
    return { ...this.translationProvenance, blocks };
  }

  private navigationKey(): string {
    const url = new URL(this.document.URL);
    // Ordinary heading anchors do not change the article; hash-router paths do.
    if (!/^#!?\//.test(url.hash)) url.hash = '';
    return url.href;
  }

  private observe(): void {
    this.observer.observe(this.document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }

  private isCurrentSource(): boolean {
    if (!this.sourceVersion || !this.blockVersion) return false;
    try {
      const version = sourceDocumentVersion(this.document);
      const bindingsCurrent = this.blocks.every(block => this.renderer.hasCurrentBindings(block));
      if (version === this.sourceVersion && bindingsCurrent) return true;
      if (translationTitle(this.document) !== this.sourceTitle) { this.invalidate('文章标题已变化'); return false; }
      if (this.document.documentElement.lang !== this.sourceLanguage) { this.invalidate('页面语言已变化'); return false; }

      const current = extractBlocksSync(this.document);
      const currentVersion = blockDocumentVersion(current);
      if (currentVersion !== this.blockVersion) {
        this.invalidate(sourceChangeReason(this.blockVersion, currentVersion));
        return false;
      }
      const policyChanged = current.some((block, index) => block.canHideSource !== this.blocks[index]!.canHideSource);
      const snapshotsChanged = current.some((block, index) => block.snapshot !== this.blocks[index]!.snapshot);
      if (!bindingsCurrent || policyChanged || snapshotsChanged) {
        // React can rebuild the same content. Keep the SDK job and its settled
        // results, but restore output and bind it to the site's new originals.
        this.mutate(() => {
          this.renderer.restore();
          const rebound = extractBlocksSync(this.document);
          if (blockDocumentVersion(rebound) !== this.blockVersion) throw new Error('正文在重新绑定时变化');
          this.setBlocks(rebound);
          for (const [id, text] of this.translated) {
            if (!this.renderer.render(this.byId.get(id)!, text)) throw new Error('正文节点暂不可用');
          }
        });
      }
      this.sourceVersion = sourceDocumentVersion(this.document);
      return true;
    } catch {
      this.invalidate('页面正在重建正文，暂无法安全继续');
      return false;
    }
  }

  private setBlocks(blocks: ProtectedBlock[]): void {
    this.blocks = blocks;
    this.byId = new Map(blocks.map(block => [block.input.id, block]));
    const scope = findContentScope(this.document);
    this.usesDocumentTitle = !scope.keepSource;
  }

  private invalidate(reason: string): void {
    this.stop(); this.mutate(() => this.renderer.restore());
    this.sourceVersion = undefined;
    this.blockVersion = undefined;
    this.state.status = 'stale'; this.state.error = `已停止：${reason}。点击“重新翻译”处理最新正文，仍有效的缓存译文会复用。`;
  }

  private mutate(action: () => void): void {
    this.observer.disconnect();
    try { action(); } finally { this.observe(); }
  }

  start(mode: DisplayMode, translationSessionId?: string): void {
    this.restore();
    this.url = this.navigationKey();
    const revision = ++this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.state.mode = mode;
    this.state.execution = translationSessionId ? 'translation' : 'preview';
    this.state.status = 'extracting';
    this.renderer.setMode(mode);
    void this.run(revision, abort.signal, translationSessionId);
  }

  private async run(revision: number, signal: AbortSignal, translationSessionId?: string): Promise<void> {
    try {
      let blocks: ProtectedBlock[] = [];
      // Capture a stable input before sending anything to the provider. Host
      // layout/hydration can finish while the cooperative extractor yields.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = sourceDocumentVersion(this.document);
        blocks = await extractBlocks(this.document, signal);
        if (revision !== this.revision || signal.aborted) return;
        const after = sourceDocumentVersion(this.document);
        if (before === after && blocks.every(block => this.renderer.isCurrent(block))) {
          this.sourceVersion = after;
          break;
        }
        // A loading label can change on every yield without changing any
        // translation input. Reconcile the current input and bindings once.
        const current = extractBlocksSync(this.document);
        if (blockDocumentVersion(blocks) === blockDocumentVersion(current)) {
          blocks = current;
          this.sourceVersion = sourceDocumentVersion(this.document);
          break;
        }
      }
      if (!this.sourceVersion) throw new Error('正文正在更新，请稍后点击“重新翻译”。');
      this.setBlocks(blocks);
      this.blockVersion = blockDocumentVersion(blocks);
      this.sourceTitle = translationTitle(this.document);
      this.sourceLanguage = this.document.documentElement.lang;
      this.state.total = blocks.length;
      if (!blocks.length) throw new Error('没有找到可翻译的正文。请等待帖子或文章加载完成后重试，也可以选中文字再翻译。PDF、浏览器内部页面和嵌入框架暂不支持。');
      this.state.status = 'translating';

      const document = {
        id: this.state.pageSessionId,
        title: translationTitle(this.document, blocks),
        sourceLanguage: this.sourceLanguage || undefined,
        blocks: blocks.map((block) => block.block),
      };
      const settled = new Set<string>();
      const results = translationSessionId ? translateInBackground(document, translationSessionId, signal, {
        isCurrent: () => {
          if (revision !== this.revision || this.navigationKey() !== this.url) return false;
          if (!this.isCurrentSource()) return false;
          return true;
        },
        onProvenance: value => { this.translationProvenance = value; },
        onRecover: () => { this.state.status = 'recovering'; this.state.recoveries++; },
      })
        : this.engine.translate(document, { targetLanguage: 'zh-CN', signal });
      for await (const output of results) {
        if (revision !== this.revision || signal.aborted || this.navigationKey() !== this.url) return;
        if (!this.isCurrentSource()) return;
        this.state.status = 'translating'; this.state.metrics = output.metrics;
        this.mutate(() => {
          for (const translation of output.translations) {
            if (settled.has(translation.id)) continue;
            settled.add(translation.id);
            if (this.renderer.render(this.byId.get(translation.id)!, translation.text)) {
              this.translated.set(translation.id, translation.text);
              this.state.completed++;
            }
            else this.state.failed++;
          }
          for (const failure of output.failures ?? []) {
            if (settled.has(failure.id)) continue;
            settled.add(failure.id); this.state.failed++; this.state.error ??= failure.error;
          }
        });
      }
      if (revision === this.revision) this.state.status = this.state.failed ? this.state.completed ? 'partial' : 'error' : 'completed';
    } catch (error) {
      if (revision !== this.revision || signal.aborted) return;
      this.state.status = 'error';
      this.state.error = errorMessage(error);
      this.state.failed = Math.max(this.state.failed, this.state.total - this.state.completed);
    }
  }

  setMode(mode: DisplayMode): void {
    this.state.mode = mode;
    this.mutate(() => this.renderer.setMode(mode));
  }

  stop(): void {
    this.revision++;
    this.abort?.abort();
    this.abort = undefined;
    if (['translating', 'extracting', 'recovering'].includes(this.state.status)) this.state.status = 'cancelled';
  }

  restore(): void {
    this.stop();
    this.mutate(() => this.renderer.restore());
    this.blocks = [];
    this.byId.clear();
    this.translated.clear();
    this.translationProvenance = undefined;
    this.sourceVersion = undefined;
    this.blockVersion = undefined;
    this.state = {
      pageSessionId: crypto.randomUUID(), status: 'idle', mode: this.state.mode, execution: 'preview', total: 0, completed: 0, failed: 0, fallback: 0, recoveries: 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.capturedResources = undefined;
    this.restore();
    this.observer.disconnect();
    clearInterval(this.interval);
  }
}
