import { parse } from 'parse5';
import type {
  ReaderIR,
  ReaderBlock,
  ReaderNode,
} from '@pagelingo/document-contracts';
import type { BlockKind } from '@pagelingo/translation-core';
import type {
  VerifiedP0Run,
  VerifiedPreview,
  PdfInspection,
} from './local-run.js';
import { readVerified, requireInput } from './verified-input.js';
import {
  element,
  children,
  attr,
  hasClass,
  findElements,
  projectInline,
  textContent,
  type HtmlNode,
} from './legacy-inline.js';
import { mapSource, type SourceContext } from './source-map.js';
import { legacyAsset } from './legacy-assets.js';
const containers = new Set([
  'article',
  'section',
  'div',
  'figure',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'nav',
]);
const imageLink = (n: HtmlNode): boolean =>
  element(n) &&
  n.tagName === 'a' &&
  findElements(n, (child) => child.tagName === 'img').length > 0;
const blockLike = (n: HtmlNode): boolean =>
  element(n) &&
  (containers.has(n.tagName) ||
    imageLink(n) ||
    [
      'p',
      'pre',
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'figcaption',
      'hr',
      'table',
      'svg',
      'math',
      'iframe',
      'object',
      'canvas',
    ].includes(n.tagName));
const furniture = new Set([
  'page_header',
  'page_footer',
  'page_number',
  'header',
  'footer',
]);
export async function projectLegacyPages(
  run: VerifiedP0Run,
  preview: VerifiedPreview,
  inspection: PdfInspection,
  ir: ReaderIR,
  makeId: (prefix: string, source: string, path: string) => string,
) {
  const anchors = new Map<string, string>();
  const pendingLinks: {
    blockId: string;
    pagePath: string;
    id: string;
    href: string;
  }[] = [];
  preview.bindings.length = 0;
  preview.assetFiles.clear();
  for (const page of [...preview.metadata.pages].sort(
    (a, b) => a.sourcePageIndex - b.sourcePageIndex,
  )) {
    const document = parse((await readVerified(preview, page.path)).toString());
    const articles = findElements(document, (n) =>
      hasClass(n, 'docvortex-document'),
    );
    requireInput(
      articles.length === 1,
      'Preview must contain one semantic article',
    );
    const pdfPage = inspection.pages[page.sourcePageIndex];
    const addBlock = (
      block: ReaderBlock,
      node: HtmlNode,
      path: string,
      context: SourceContext,
    ): string => {
      ir.blocks.push(block);
      const id = makeId('n_', block.id, `${path}/node`);
      ir.nodes.push({ id, kind: 'block', children: [], blockId: block.id });
      const mapping = mapSource(run, preview, pdfPage, context);
      preview.bindings.push({
        blockId: block.id,
        semanticFile: page.path,
        semanticPointer: path,
        ...mapping.lineage,
      });
      if (mapping.lineage.warning)
        ir.warnings.push(`${mapping.lineage.warning}:${block.id}`);
      if (attr(node, 'id'))
        anchors.set(`${page.path}#${attr(node, 'id')}`, block.id);
      return id;
    };
    const visit = async (
      n: HtmlNode,
      path: string,
      parent: SourceContext,
    ): Promise<string[]> => {
      if (!element(n)) {
        if (!textContent(n).trim()) return [];
      } else if (
        furniture.has(attr(n, 'data-block-type') ?? '') ||
        ['script', 'style', 'template'].includes(n.tagName)
      )
        return [];
      const blockIndex = attr(n, 'data-block-index');
      const context: SourceContext = {
        ...parent,
        ...(blockIndex !== undefined
          ? { blockIndex: Number(blockIndex), sourceId: undefined }
          : {}),
        ...(attr(n, 'data-source-id')
          ? { sourceId: attr(n, 'data-source-id') }
          : {}),
      };
      const mapping = mapSource(run, preview, pdfPage, context);
      const source =
        mapping.lineage.rawRef ??
        mapping.lineage.evidencePointer ??
        `${page.path}#${path}`;
      const blockId = (): string => makeId('b_', source, path);
      const tag = element(n) ? n.tagName : '';
      if (tag === 'img') {
        const asset = await legacyAsset(
          preview,
          page.path,
          attr(n, 'src') ?? '',
        );
        if (!ir.assets.some((a) => a.id === asset.id)) ir.assets.push(asset);
        const role = hasClass(n, 'docvortex-table-image')
          ? 'table'
          : hasClass(n, 'docvortex-equation-image')
            ? 'formula'
            : 'figure';
        return [
          addBlock(
            {
              id: blockId(),
              type: 'image',
              sourceRefs: [mapping.ref],
              assetId: asset.id,
              alt: attr(n, 'alt') ?? '',
              role,
              originalRegion: mapping.ref,
            },
            n,
            path,
            context,
          ),
        ];
      }
      if (tag === 'pre')
        return [
          addBlock(
            {
              id: blockId(),
              type: 'code',
              sourceRefs: [mapping.ref],
              code: textContent(n),
            },
            n,
            path,
            context,
          ),
        ];
      if (tag === 'hr')
        return [
          addBlock(
            { id: blockId(), type: 'rule', sourceRefs: [mapping.ref] },
            n,
            path,
            context,
          ),
        ];
      const latex = attr(n, 'data-docvortex-latex');
      if (
        latex !== undefined &&
        (tag === 'div' || hasClass(n, 'katex-display'))
      )
        return [
          addBlock(
            {
              id: blockId(),
              type: 'math',
              sourceRefs: [mapping.ref],
              latex,
              displayMode: true,
            },
            n,
            path,
            context,
          ),
        ];
      const hasBlocks = children(n).some(blockLike);
      const structural =
        (containers.has(tag) || imageLink(n)) &&
        (hasBlocks || ['ul', 'ol', 'li', 'section', 'article'].includes(tag));
      if (structural) {
        let kind: ReaderNode['kind'] = 'group';
        if (tag === 'ul' || tag === 'ol') kind = 'list';
        else if (tag === 'li') kind = 'list-item';
        else if (hasClass(n, 'pl-callout')) kind = 'callout';
        else if (tag === 'section') kind = 'section';
        const id = makeId('n_', source, path);
        const nodeChildren: string[] = [];
        // Group adjacent inline siblings so labels/whitespace remain in original reading order.
        let inline: HtmlNode[] = [];
        let inlineStart = 0;
        const flush = async () => {
          if (inline.some((c) => textContent(c).trim())) {
            const projected = projectInline(inline, ir.warnings);
            const idb = makeId('b_', source, `${path}/inline-${inlineStart}`);
            pendingLinks.push(
              ...projected.links.map((link) => ({
                ...link,
                blockId: idb,
                pagePath: page.path,
              })),
            );
            nodeChildren.push(
              addBlock(
                {
                  id: idb,
                  type: 'text',
                  sourceRefs: [mapping.ref],
                  value: {
                    id: idb,
                    kind: 'paragraph',
                    content: projected.content,
                  },
                  bindings: projected.bindings,
                  language: { language: 'und', reason: 'uncertain' },
                },
                n,
                `${path}/inline-${inlineStart}`,
                context,
              ),
            );
          }
          inline = [];
        };
        for (const [i, c] of children(n).entries()) {
          const isBlock = blockLike(c);
          if (isBlock) {
            await flush();
            nodeChildren.push(...(await visit(c, `${path}/${i}`, context)));
          } else {
            if (!inline.length) inlineStart = i;
            inline.push(c);
          }
        }
        await flush();
        if (!nodeChildren.length) return [];
        let node: ReaderNode;
        if (kind === 'list')
          node = {
            id,
            kind,
            children: nodeChildren,
            ordered: tag === 'ol',
            ...(tag === 'ol' && attr(n, 'start')
              ? { start: Number(attr(n, 'start')) }
              : {}),
          };
        else if (kind === 'callout')
          node = {
            id,
            kind,
            children: nodeChildren,
            semantic: findElements(n, (c) => hasClass(c, 'pl-prompt')).length
              ? 'prompt'
              : hasClass(n, 'pl-source-example')
                ? 'example'
                : 'note',
          };
        else if (kind === 'section')
          node = { id, kind, children: nodeChildren };
        else
          node = {
            id,
            kind: kind as 'group' | 'list-item',
            children: nodeChildren,
          };
        if (hasClass(n, 'pl-source-centered'))
          node.presentation = { align: 'center' };
        ir.nodes.push(node);
        return [id];
      }
      const kind: BlockKind = /^h[1-6]$/.test(tag)
        ? 'heading'
        : tag === 'figcaption' || hasClass(n, 'docvortex-caption')
          ? 'caption'
          : tag === 'blockquote'
            ? 'quote'
            : 'paragraph';
      const unsupported = [
        'table',
        'svg',
        'math',
        'iframe',
        'object',
        'canvas',
      ].includes(tag);
      if (!textContent(n).trim() && latex === undefined && !unsupported)
        return [];
      const id = blockId();
      const projected = projectInline(
        element(n) ? children(n) : [n],
        ir.warnings,
      );
      pendingLinks.push(
        ...projected.links.map((link) => ({
          ...link,
          blockId: id,
          pagePath: page.path,
        })),
      );
      if (unsupported) {
        ir.warnings.push(
          `unsupported-visible-element:${tag}:source-only:${id}`,
        );
        projected.content = [
          {
            type: 'protected',
            id: 'fallback',
            kind: 'literal',
            source: textContent(n) || `[${tag} in source PDF]`,
          },
        ];
        projected.bindings = [
          {
            kind: 'protected',
            id: 'fallback',
            object: {
              type: 'literal',
              text: textContent(n) || `[${tag} in source PDF]`,
            },
          },
        ];
      }
      return [
        addBlock(
          {
            id,
            type: 'text',
            sourceRefs: [mapping.ref],
            value: { id, kind, content: projected.content },
            bindings: projected.bindings,
            language: { language: 'und', reason: 'uncertain' },
          },
          n,
          path,
          context,
        ),
      ];
    };
    ir.roots.push(
      ...(await visit(articles[0], '#/article', {
        pageIndex: page.sourcePageIndex,
        parsedPageIndex: page.parsedPageIndex,
      })),
    );
  }
  return { anchors, pendingLinks };
}
