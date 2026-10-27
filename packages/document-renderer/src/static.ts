import type { ReaderBuild } from './chunking.js';
import { renderChunk } from './html.js';
import { escapeHtml } from './math.js';
import { rendererVersion, rendererSha256, trustedStaticAssets } from './static-catalog.js';
export interface OfflineMetadata { title: string; originalFilename: string }
export interface GeneratedStaticFile { path: string; mediaType: string; content: string }
export interface TrustedAsset {
  path: string; mediaType: string; bytes: number; sha256: string;
  /** Resolve relative to the installed package, then verify bytes/hash before writing. */
  source: { package: '@pagelingo/document-renderer' | 'katex'; path: string };
}
export interface StaticFilePlan {
  rendererVersion: string; rendererSha256: string;
  trustedAssets: readonly TrustedAsset[];
  generatedFiles: Iterable<GeneratedStaticFile>;
}
const registrationJson = (value: unknown): string => JSON.stringify(value).replace(/[<&\u2028\u2029]/g, char => ({'<':'\\u003c','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'}[char]!));

/** Iteration materializes only the next file. No DOM, filesystem or font IO here. */
export function createStaticFilePlan(build: ReaderBuild, metadata: OfflineMetadata): StaticFilePlan {
  return {
    rendererVersion, rendererSha256, trustedAssets: trustedStaticAssets,
    generatedFiles: { *[Symbol.iterator](): Iterator<GeneratedStaticFile> {
      yield { path: 'render/index.html', mediaType: 'text/html', content: `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(metadata.title)}</title><link rel="stylesheet" href="../assets/reader.css"><link rel="stylesheet" href="../assets/katex/katex.min.css"></head>
<body><header><h1 id="title">${escapeHtml(metadata.title)}</h1><p id="status"></p><button id="toc-toggle">目录</button><button data-view="split">对照</button><button data-view="source">原 PDF</button><button data-view="content">正文</button><button id="mode">译文 / 原文</button><button id="font">大字</button><a href="../source.pdf" target="_blank" rel="noopener">打开 / 下载 ${escapeHtml(metadata.originalFilename)}</a></header><nav id="toc" aria-label="目录"></nav><main id="reader"><section id="pdf-pane"><iframe id="pdf" title="原 PDF" src="../source.pdf"></iframe></section><div id="divider" role="separator" aria-label="调整分栏" aria-orientation="vertical" tabindex="0" aria-valuemin="30" aria-valuemax="70" aria-valuenow="50"></div><section id="content-pane"><div id="content"></div><footer><button id="previous">上一片</button><span id="location"></span><button id="next">下一片</button></footer></section></main><script src="../assets/offline-runtime.js"></script><script src="data/index.js"></script></body></html>` };
      yield { path: 'render/data/index.js', mediaType: 'text/javascript', content: `PageLingoReader.registerIndex(${registrationJson({ metadata, index: build.index })});\n` };
      for (const chunk of build.chunks) {
        const resolveAsset = (id: string): string => {
          const asset = chunk.assets.find(asset => asset.id === id);
          if (!asset) throw new Error('Missing static asset');
          return `../${asset.path}`;
        };
        const source = renderChunk(chunk, { mode: 'source', resolveAsset });
        const translation = renderChunk(chunk, { mode: 'translation', resolveAsset });
        yield { path: `render/data/${chunk.id}.js`, mediaType: 'text/javascript', content: `PageLingoReader.registerChunk(${registrationJson({ chunk, source, translation })});\n` };
      }
    } },
  };
}
