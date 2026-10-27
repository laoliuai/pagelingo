import { findContentScope } from '../../dom/content-scope';
import { parseSourceTime, originalSourceText, sourceMetadata, type ArchiveSource } from './blog';

const QUOTES = '[data-testid="quoteTweet"],[data-testid="quotedTweet"],[data-testid="simpleTweet"],[data-testid="card.wrapper"]';
export function xSource(document: Document): ArchiveSource {
  const metadata = sourceMetadata(document);
  const url = new URL(document.URL);
  const requested = /\/status\/\d+(?:\/|$)/.test(url.pathname);
  const scope = findContentScope(document);
  if (!requested || (!scope.roots.length && !scope.sourcePost)) return { ...metadata, roots: [], kind: 'x-post', warnings: ['Requested main post is unavailable; open its standalone status link and wait for it to load.'] };
  const post = scope.sourcePost ?? scope.roots[0]?.closest<HTMLElement>('article[data-testid="tweet"]');
  const own = <T extends Element>(selector: string): T[] => post ? Array.from(post.querySelectorAll<T>(selector)).filter(node => node.closest('article[data-testid="tweet"]') === post && !node.closest(QUOTES)) : [];
  const roots = [...scope.roots];
  for (const media of own<HTMLElement>('[data-testid="tweetPhoto"],video')) if (!roots.some(root => root.contains(media))) roots.push(media);
  if (!roots.length) return { ...metadata, roots: [], kind: 'x-post', warnings: ['Requested main post has no loaded text or media.'] };
  const time = own<HTMLTimeElement>('a time')[0];
  return {
    ...metadata, roots, kind: 'x-post',
    title: originalSourceText(scope.roots[0]) || metadata.title,
    author: originalSourceText(own<HTMLElement>('[data-testid="User-Name"]')[0]) || null,
    publishedAt: parseSourceTime(time?.getAttribute('datetime')),
    warnings: [
      ...(own('video').length ? ['Video is not archived; only available main-post images and text are captured.'] : []),
      ...(own('[data-testid="tweet-text-show-more-link"],[data-testid="tweet-text-show-more-button"]').length ? ['Post text is truncated and was not expanded; only loaded source is captured.'] : []),
    ],
  };
}
