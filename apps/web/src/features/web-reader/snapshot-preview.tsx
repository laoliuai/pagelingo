import { useEffect, useState } from 'react';
import { defaultCaptureLimits, type CaptureFile, type WebCaptureManifest, type WebReaderDescriptor, type WebSourceRef } from '@pagelingo/document-contracts';
import { apiSessionSignal } from '../../shared/api-client';
import { locateWebSource } from './web-source-locator';
const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; font-src 'none'";
async function readFile(descriptor: WebReaderDescriptor, file: CaptureFile, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`/api/v1/documents/${descriptor.documentId}/web-snapshots/${descriptor.source.sourceVersionId}/files/${encodeURIComponent(file.id)}`, { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok || !response.body) throw Error('快照资源读取失败');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > file.bytes) { await reader.cancel(); throw Error('快照资源超出声明大小'); } chunks.push(value); }
  signal.throwIfAborted(); const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (size !== file.bytes || hash !== file.sha256) throw Error('快照资源完整性校验失败');
  return bytes;
}
async function imageData(bytes: Uint8Array<ArrayBuffer>, mediaType: string): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(new Blob([bytes], { type: mediaType })); });
  const image = new Image(); image.src = data; await image.decode(); return data;
}
export function SnapshotPreview({ descriptor, manifest, reference }: { descriptor: WebReaderDescriptor; manifest: WebCaptureManifest; reference: WebSourceRef }) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, apiSessionSignal()]); let blob = '';
    setUrl(''); setError(''); setWarnings([]);
    void (async () => {
      const location = locateWebSource(descriptor, reference);
      if (!location) throw Error('该节点没有有界预览，请下载原件查看。');
      const { preview, anchorId } = location;
      if (preview.blockIds.length > 128 || preview.htmlBytes > defaultCaptureLimits.maxPreviewHtmlBytes || preview.resourceBytes > defaultCaptureLimits.maxPreviewResourceBytes) throw Error('快照超出预览预算');
      const files = new Map(manifest.files.map(file => [file.id, file])); const html = files.get(preview.fileId);
      if (!html || html.role !== 'preview' || html.bytes !== preview.htmlBytes) throw Error('快照文件身份不匹配');
      const bytes = await readFile(descriptor, html, signal);
      const document = new DOMParser().parseFromString(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'text/html');
      document.querySelectorAll('script,iframe,object,embed,form,input,button,meta,base,link,style,audio,video,source').forEach(node => node.remove());
      const localIds = new Set([...document.querySelectorAll('[id]')].map(node => node.id));
      for (const node of document.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || ['src','srcset','srcdoc','action','formaction','target','ping','download'].includes(name)) node.removeAttribute(attribute.name);
        if (name === 'href' || name === 'xlink:href') {
          const target = attribute.value;
          if (!target.startsWith('#') || !localIds.has(target.slice(1))) node.removeAttribute(attribute.name);
        }
      }
      const failed: string[] = []; const images = new Map<string, string>(); let resourceBytes = 0;
      for (const id of preview.resourceFileIds) {
        const file = files.get(id); if (!file || file.role !== 'image' || !['image/png','image/jpeg','image/webp','image/gif'].includes(file.mediaType)) throw Error('快照引用了未授权资源');
        resourceBytes += file.bytes; if (resourceBytes > defaultCaptureLimits.maxPreviewResourceBytes) throw Error('快照资源超出预算');
        try { images.set(id, await imageData(await readFile(descriptor, file, signal), file.mediaType)); }
        catch (error) { signal.throwIfAborted(); failed.push(`归档图片无法读取或解码：${id}`); }
      }
      const resources = new Map(manifest.resources.map(resource => [resource.id, resource]));
      for (const node of document.querySelectorAll('[data-pl-resource]')) {
        const resource = resources.get(node.getAttribute('data-pl-resource')!);
        const data = resource?.status === 'available' ? images.get(resource.fileId) : undefined;
        if (node.tagName === 'IMG' && data) node.setAttribute('src', data);
        else { const warning = document.createElement('span'); warning.textContent = '［图片缺失或无法解码］'; node.replaceWith(warning); }
      }
      const target = [...document.querySelectorAll('[data-pl-node]')].find(node => node.getAttribute('data-pl-node') === reference.nodeId);
      if (!target) throw Error('快照未包含固定源节点');
      target.id = anchorId;
      const charset = document.createElement('meta'); charset.setAttribute('charset', 'utf-8'); document.head.prepend(charset);
      const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = csp; document.head.prepend(meta);
      const style = document.createElement('style'); style.textContent = 'body{font:16px/1.8 system-ui;margin:20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre,table{display:block;max-width:100%;overflow:auto}:target{outline:2px solid #478d7a}'; document.head.append(style);
      signal.throwIfAborted(); blob = URL.createObjectURL(new Blob(['<!doctype html>' + document.documentElement.outerHTML], { type: 'text/html' }));
      setWarnings(failed); setUrl(`${blob}#${encodeURIComponent(anchorId)}`);
    })().catch(error => { if (!signal.aborted) setError(error instanceof Error ? error.message : '快照加载失败'); });
    const release = () => { if (blob) URL.revokeObjectURL(blob); blob = ''; setUrl(''); };
    signal.addEventListener('abort', release, { once: true });
    return () => { controller.abort(); release(); };
  }, [descriptor, manifest, reference.nodeId]);
  return <div className="web-snapshot"><p>归档快照 · 已清洗外观；外部链接由阅读器打开。</p>{error && <p role="alert">{error}</p>}{warnings.map(warning => <p role="status" key={warning}>{warning}</p>)}{url ? <iframe title="归档快照" sandbox="" referrerPolicy="no-referrer" src={url} /> : !error && <p role="status">正在校验快照片段…</p>}</div>;
}
