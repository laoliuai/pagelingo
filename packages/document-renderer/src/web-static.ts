import { hash } from 'fast-sha256';
import { bundlePathSchema, defaultCaptureLimits, webCaptureManifestSchema, webReaderIndexSchema, webReaderChunkSchema, type WebReaderIR, type WebTranslation, type WebReaderIndex, type WebReaderChunk, type WebCaptureManifest } from '@pagelingo/document-contracts';
import { buildWebReader } from './web-chunking.js';
import { renderWebChunk } from './web-html.js';
import { escapeHtml as esc } from './math.js';
import { renderOfflinePreview } from './web-preview.js';
import type { StaticFilePlan, TrustedAsset, GeneratedStaticFile } from './static.js';
import { webRendererVersion, webRendererSha256, trustedWebStaticAssets } from './web-static-catalog.js';

export interface WebOfflineAsset { id: string; path: string; mediaType: string; bytes: number; sha256: string }
/** Exact decoded UTF-8 of a registered archived preview, not a trusted HTML type. */
export interface WebOfflinePreview { fileId: string; html: string }
export interface WebOfflinePreviewImage { fileId: string; data: Uint8Array }
export interface WebStaticPlanInput {
  ir: WebReaderIR; translation: WebTranslation | null; index: WebReaderIndex;
  chunks: readonly WebReaderChunk[]; capture: WebCaptureManifest; assets: readonly WebOfflineAsset[];
  previews?: readonly WebOfflinePreview[];
  previewImages?: readonly WebOfflinePreviewImage[];
}
export interface WebStaticFilePlan extends StaticFilePlan {}
export interface TrustedWebRendererCatalog {
  readonly version: string; readonly codeSha256: string; readonly trustedAssets: readonly TrustedAsset[];
  readonly generateFiles: (input: WebStaticPlanInput) => Iterable<GeneratedStaticFile>;
}
const utf8 = (s: string) => new TextEncoder().encode(s);
const digestBytes = (bytes: Uint8Array) => Array.from(hash(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = (s: string) => digestBytes(utf8(s));
const base64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 24576) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
  return parts.join('');
};
const check = (ok: unknown, message: string): void => { if (!ok) throw Error(message); };
const json = (value: unknown): string => JSON.stringify(value).replace(/[<&\u2028\u2029]/g, char => ({ '<': '\\u003c', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }[char]!));
// Object order does not establish identity; array/reading order does.
const canonical = (value: unknown): string => value !== null && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  : JSON.stringify(value);
const file = (path: string, content: string, mediaType = 'text/javascript'): GeneratedStaticFile => ({ path, content, mediaType });

/** Pure, repeatable iteration: only one chunk's three rendered modes is materialized at a time.
 * Bytes of source assets are verified by the bundle caller; this binds their exact manifest descriptors.
 */
export function createWebStaticFilePlan(input: WebStaticPlanInput): WebStaticFilePlan {
  return { rendererVersion: webRendererVersion, rendererSha256: webRendererSha256, trustedAssets: trustedWebStaticAssets,
    generatedFiles: { *[Symbol.iterator](): Iterator<GeneratedStaticFile> {
      check(utf8(JSON.stringify(input.capture)).length <= defaultCaptureLimits.maxIrBytes, 'Capture manifest byte budget exceeded');
      const capture = webCaptureManifestSchema.parse(input.capture);
      const source = capture.files.find(f => f.id === capture.htmlFileId)!;
      check(source.sha256 === input.ir.source.snapshotSha256, 'Capture snapshot identity mismatch');
      const build = buildWebReader(input.ir, input.translation);
      check(canonical(webReaderIndexSchema.parse(input.index)) === canonical(build.index), 'Web index does not match source/translation');
      check(input.chunks.length === build.chunks.length, 'Web chunk count mismatch');
      check(input.assets.length <= defaultCaptureLimits.maxFiles, 'Web offline asset budget exceeded');
      const assets = new Map(input.assets.map(asset => [asset.id, asset]));
      check(assets.size === input.assets.length, 'Duplicate offline asset ID');
      const captureFiles = new Map(capture.files.map(f => [f.id, f]));
      const archivedPaths = new Map(capture.files.map(f => [`source/${f.path}`, f]));
      for (const asset of assets.values()) {
        bundlePathSchema.parse(asset.path);
        const original = archivedPaths.get(asset.path);
        check(original?.role === 'image' && asset.mediaType === original.mediaType && asset.bytes === original.bytes && asset.sha256 === original.sha256, 'Offline asset does not match archived image');
      }
      for (const asset of input.ir.assets) {
        const local = assets.get(asset.id), original = captureFiles.get(asset.id);
        check(local && original?.path === asset.path && local.bytes === asset.bytes && local.sha256 === asset.sha256 && local.mediaType === asset.mediaType, 'Missing or changed Web image binding');
      }
      check((input.previewImages?.length ?? 0) <= defaultCaptureLimits.maxFiles, 'Preview image file budget exceeded');
      const previewImages = new Map<string, { url: string; bytes: number }>(); let totalImageBytes = 0;
      const previewImageIds = new Set(capture.snapshots.previews.flatMap(p => p.resourceFileIds));
      for (const image of input.previewImages ?? []) {
        const original = captureFiles.get(image.fileId);
        check(!previewImages.has(image.fileId) && previewImageIds.has(image.fileId) && original?.role === 'image', 'Unregistered or duplicate preview image');
        check(image.data instanceof Uint8Array && image.data.byteLength <= defaultCaptureLimits.maxResourceBytes && image.data.byteLength === original!.bytes && digestBytes(image.data) === original!.sha256, 'Preview image byte/hash mismatch');
        totalImageBytes += image.data.byteLength;
        check(totalImageBytes <= defaultCaptureLimits.maxTotalBytes, 'Preview image total byte budget exceeded');
        previewImages.set(image.fileId, { url: `data:${original!.mediaType};base64,${base64(image.data)}`, bytes: image.data.byteLength });
      }
      const previews = new Map((input.previews ?? []).map(p => [p.fileId, p]));
      check(previews.size === (input.previews ?? []).length && previews.size <= capture.snapshots.previews.length, 'Duplicate or excessive offline previews');
      for (const preview of previews.values()) {
        const original = captureFiles.get(preview.fileId);
        check(original?.role === 'preview' && capture.snapshots.previews.some(p => p.fileId === preview.fileId), 'Unregistered offline preview');
        check(utf8(preview.html).length <= defaultCaptureLimits.maxPreviewHtmlBytes && utf8(preview.html).length === original!.bytes && digest(preview.html) === original!.sha256, 'Offline preview byte/hash mismatch');
      }
      const previewFiles = new Map(capture.snapshots.previews.map((p, i) => [p.id, previews.has(p.fileId) ? `previews/p_${i + 1}.html` : null]));
      const locations = Object.entries(capture.snapshots.nodeLocations).map(([nodeId, location]) => ({ nodeId, path: previewFiles.get(location.previewId) ?? null, anchorId: `pl_${nodeId}` }));
      const warnings = [...new Set([...capture.scope.warnings, ...input.ir.warnings, ...input.index.warnings, ...capture.resources.filter(r => r.status === 'missing').map(r => `资源缺失：${r.id} (${r.reason})`)])];
      yield file('render/index.html', `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'"><title>${esc(input.ir.metadata.title)}</title><link rel="stylesheet" href="../assets/web-reader.css"><link rel="stylesheet" href="../assets/katex/katex.min.css"></head><body><header><h1>${esc(input.ir.metadata.title)}</h1><p id="status" role="status">离线阅读器正在加载；若无法启动，请重新校验离线包。</p><div class="controls"><button data-mode="source">原文</button><button data-mode="translation">译文</button><button data-mode="bilingual">双语</button><button id="theme">切换主题</button></div><details id="provenance"><summary>来源范围与资源缺失</summary><p>${esc(capture.source.url)}</p><p>${capture.scope.completeWithinScope ? '已保存所选范围；不代表整个来源站点。' : '来源范围不完整。'}</p><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul><p>原始 HTML/CSS 仅作为附件保存在 source 目录，不在阅读器执行。</p></details></header><nav id="toc" aria-label="目录"></nav><main><section id="content" aria-label="正文"></section><section id="preview" hidden><button id="close-preview">返回正文</button><p id="preview-status" role="status"></p><div id="preview-frame"></div></section></main><footer><button id="previous">上一片</button><label>正文分片 <input id="chunk-number" type="number" min="1" value="1"></label><button id="go">跳转正文</button><span id="location"></span><button id="next">下一片</button></footer><script src="../assets/web-offline-runtime.js"></script><script src="data/index.js"></script></body></html>`, 'text/html');
      yield file('render/data/index.js', `PageLingoWebReader.registerIndex(${json({ index: input.index, locations })});\n`);
      for (const [i, chunk] of input.chunks.entries()) {
        check(canonical(webReaderChunkSchema.parse(chunk)) === canonical(build.chunks[i]), 'Web chunk does not match source/translation');
        const resolveAsset = (id: string) => {
          const asset = assets.get(id); check(asset, 'Missing offline asset');
          return `../${asset!.path.split('/').map(encodeURIComponent).join('/')}`;
        };
        const modes = Object.fromEntries((['source', 'translation', 'bilingual'] as const).map(mode => [mode, renderWebChunk(chunk, { mode, resolveAsset })]));
        yield file(`render/data/${chunk.id}.js`, `PageLingoWebReader.registerChunk(${json({ id: chunk.id, modes, images: chunk.assets.map(a => ({ id: a.id, url: resolveAsset(a.id) })) })});\n`);
      }
      for (const preview of capture.snapshots.previews) {
        const value = previews.get(preview.fileId), path = previewFiles.get(preview.id);
        if (value && path) yield file(`render/${path}`, renderOfflinePreview(value.html, preview, capture, previewImages), 'text/html');
      }
    } },
  };
}
const catalog: TrustedWebRendererCatalog = Object.freeze({ version: webRendererVersion, codeSha256: webRendererSha256, trustedAssets: trustedWebStaticAssets, generateFiles: (input: WebStaticPlanInput) => createWebStaticFilePlan(input).generatedFiles });
/** Exact Web code identity; PDF catalogs and caller-provided aliases are never accepted. */
export function resolveTrustedWebCatalog(version: string, codeSha256: string): TrustedWebRendererCatalog {
  if (version !== catalog.version || codeSha256 !== catalog.codeSha256) throw Error('Untrusted Web renderer catalog');
  return catalog;
}
