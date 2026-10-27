import { captureUrlSchema } from '@pagelingo/document-contracts';
import { isVisible } from '../../dom/selectors';
import { findContentScope } from '../../dom/content-scope';
import { parseSourceTime, originalSourceText, sourceMetadata, type ArchiveSource } from './blog';

const QUOTES = '[data-testid="quoteTweet"],[data-testid="quotedTweet"],[data-testid="simpleTweet"]';
export function xSource(document: Document): ArchiveSource {
  const metadata = sourceMetadata(document);
  const url = new URL(document.URL);
  const requested = /\/status\/\d+(?:\/|$)/.test(url.pathname);
  const scope = findContentScope(document);
  if (!requested || (!scope.roots.length && !scope.sourcePost)) return { ...metadata, roots: [], kind: 'x-post', warnings: ['Requested main post is unavailable; open its standalone status link and wait for it to load.'] };
  const post = scope.sourcePost ?? scope.roots[0]?.closest<HTMLElement>('article[data-testid="tweet"]');
  const isQuote = (node: Element): boolean => {
    if (node.closest(QUOTES) || node.closest('article[data-testid="tweet"]') !== post) return true;
    const card = node.closest('[data-testid="card.wrapper"]');
    return Boolean(card?.querySelector(`${QUOTES},article[data-testid="tweet"],[data-testid="tweetText"]`));
  };
  const own = <T extends Element>(selector: string): T[] => post ? Array.from(post.querySelectorAll<T>(selector)).filter(node => !isQuote(node)) : [];
  const roots = [...scope.roots];
  for (const media of own<HTMLElement>('[data-testid="tweetPhoto"],video')) if (!roots.some(root => root.contains(media))) roots.push(media);
  const externalUrl = (anchor: HTMLAnchorElement): string | null => {
    try {
      const url = new URL(anchor.getAttribute('href') ?? '', document.baseURI);
      return captureUrlSchema.safeParse(url.href).success && !/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)
        && isVisible(anchor) && !anchor.closest('[data-pl-owned],button,[role="button"],[aria-hidden="true"]') ? url.href : null;
    } catch { return null; }
  };
  const anchors = own<HTMLAnchorElement>('a[href]');
  const inText = (anchor: Element) => !anchor.closest('[data-testid="card.wrapper"]') && roots.some(root => root.contains(anchor));
  const represented = new Set(anchors.filter(inText).flatMap(anchor => externalUrl(anchor) ?? []));
  const externalLinks: NonNullable<ArchiveSource['externalLinks']> = [];
  for (const anchor of anchors) {
    const href = externalUrl(anchor);
    if (!href || inText(anchor) || represented.has(href)) continue;
    externalLinks.push({ url: href, text: originalSourceText(anchor) || href });
    represented.add(href);
  }
  const omittedCard = own<HTMLElement>('[data-testid="card.wrapper"]').some(card =>
    !Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).some(anchor => !isQuote(anchor) && externalUrl(anchor)));
  if (!roots.length) return { ...metadata, roots: [], kind: 'x-post', warnings: ['Requested main post has no loaded text or media.'] };
  const time = own<HTMLTimeElement>('a time')[0];
  return {
    ...metadata, roots, externalLinks, kind: 'x-post',
    title: originalSourceText(scope.roots[0]) || metadata.title,
    author: originalSourceText(own<HTMLElement>('[data-testid="User-Name"]')[0]) || null,
    publishedAt: parseSourceTime(time?.getAttribute('datetime')),
    warnings: [
      ...(omittedCard ? ['External card link is unavailable or cannot be represented safely; card omitted.'] : []),
      ...(own('video').length ? ['Video is not archived; only available main-post images and text are captured.'] : []),
      ...(own('[data-testid="tweet-text-show-more-link"],[data-testid="tweet-text-show-more-button"]').length ? ['Post text is truncated and was not expanded; only loaded source is captured.'] : []),
    ],
  };
}
