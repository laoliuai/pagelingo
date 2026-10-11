import { TranslationEngine, type TranslationDocument } from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';
import { errorMessage } from '../shared/types';
import { translateInBackground } from './background-translation';

export function showSelectionPreview(document: Document, text: string, translationSessionId?: string): () => void {
  const abort = new AbortController();
  document.querySelector('[data-pl-owned="selection"]')?.remove();
  const host = document.createElement('div');
  host.dataset.plOwned = 'selection';
  host.style.cssText = 'all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { color-scheme: light dark; }
    section { box-sizing:border-box; width:min(400px,calc(100vw - 48px)); max-height:65vh; overflow:auto; padding:20px;
      background:light-dark(#fff,#202827); color:light-dark(#243b36,#eef4f0); border:1px solid light-dark(#dce5df,#4b5c55);
      border-radius:14px; box-shadow:0 8px 36px #0003; font:14px/1.65 system-ui,sans-serif; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h2 { margin:0; font-size:16px; } p { white-space:pre-wrap; overflow-wrap:anywhere; }
    small { opacity:.75; } button { font:inherit; cursor:pointer; padding:5px 10px; border:1px solid #82988d; border-radius:6px; background:transparent; color:inherit; }
    footer { display:flex; gap:8px; } .label { font-size:12px; opacity:.65; margin-bottom:0; }
  `;
  const section = document.createElement('section');
  section.setAttribute('role', 'dialog');
  section.setAttribute('aria-label', translationSessionId ? '选中内容翻译' : '选中内容布局预览');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = translationSessionId ? '选中内容翻译' : '选中内容预览';
  const close = document.createElement('button');
  close.textContent = '关闭';
  const note = document.createElement('small');
  note.textContent = translationSessionId ? '选中文本将发送到你配置的 LLM 服务。' : '本地布局预览，未调用翻译 API。';
  const source = document.createElement('p');
  source.textContent = text;
  const label = document.createElement('p');
  label.className = 'label';
  label.textContent = translationSessionId ? '译文' : '预览文本';
  const preview = document.createElement('p');
  preview.textContent = translationSessionId ? '正在翻译…' : '正在生成预览…';
  const copy = document.createElement('button');
  copy.textContent = translationSessionId ? '复制译文' : '复制预览';
  copy.disabled = true;
  copy.addEventListener('click', () => {
    void document.defaultView?.navigator.clipboard.writeText(preview.textContent ?? '')
      .then(() => { copy.textContent = '已复制'; })
      .catch(() => { copy.textContent = '复制失败，请手动选择'; });
  });
  const cleanup = () => {
    abort.abort();
    host.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cleanup(); };
  close.addEventListener('click', cleanup);
  document.addEventListener('keydown', onKey);
  header.append(title, close);
  section.append(header, note, source, label, preview, copy);
  root.append(style, section);
  document.body.append(host);
  close.focus();
  void (async () => {
    try {
      const engine = new TranslationEngine(new MockProvider());
      const input: TranslationDocument = {
        id: crypto.randomUUID(), title: document.title,
        blocks: [{ id: 'selection', kind: 'paragraph', content: [{ type: 'text', text }] }],
      };
      const currentUrl = document.URL;
      const results = translationSessionId ? translateInBackground(input, translationSessionId, abort.signal, { isCurrent: () => host.isConnected && document.URL === currentUrl })
        : engine.translate(input, { targetLanguage: 'zh-CN', signal: abort.signal });
      for await (const batch of results) {
        if (abort.signal.aborted || !host.isConnected) return;
        if (batch.failures?.length) { preview.textContent = batch.failures[0].error; continue; }
        if (!batch.translations.length) continue;
        // A plain-text selection only produces text nodes, including restored literal markers.
        preview.textContent = batch.translations[0].content.map((inline) => inline.type === 'text' ? inline.text : '').join('');
        copy.disabled = false;
      }
    } catch (error) {
      if (!abort.signal.aborted && host.isConnected) preview.textContent = errorMessage(error);
    }
  })();
  return cleanup;
}
