import { isVisible } from '../../dom/selectors';
import { sourceMetadata, type ArchiveSource } from './blog';
export function zhihuSource(document: Document): ArchiveSource {
  const metadata = sourceMetadata(document);
  const url = new URL(document.URL);
  if (url.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+/.test(url.pathname)) {
    const roots = Array.from(document.querySelectorAll<HTMLElement>('.Post-RichTextContainer,.Post-RichText')).filter(isVisible);
    const root = roots.find(candidate => !roots.some(other => other !== candidate && other.contains(candidate)));
    if (root && roots.filter(candidate => !root.contains(candidate)).length === 0) return { ...metadata, roots: [root], kind: 'article' };
  }
  const id = url.pathname.match(/\/answer\/(\d+)(?:\/|$)/)?.[1];
  const answers = Array.from(document.querySelectorAll<HTMLElement>('.AnswerItem')).filter(isVisible);
  const matches = id ? answers.filter(answer => answer.dataset.aid === id || Array.from(answer.querySelectorAll<HTMLAnchorElement>('a[href]')).some(link => {
    try { return !link.closest('.RichContent-inner,.RichText') && new URL(link.href, document.URL).pathname.endsWith(`/answer/${id}`); } catch { return false; }
  })) : [];
  const root = matches.length === 1 ? matches[0]!.querySelector<HTMLElement>('.RichContent-inner,.RichText') : null;
  if (!root) return { ...metadata, roots: [], kind: 'answer', warnings: ['无法确定单条回答，请打开独立回答链接后收藏。'] };
  return { ...metadata, roots: [root], kind: 'answer',
    warnings: matches[0]!.querySelector('.ContentItem-more,[aria-expanded="false"],.RichContent.is-collapsed') ? ['Answer was not expanded; only loaded source is captured.'] : [],
    author: matches[0]!.querySelector('.AuthorInfo-name')?.textContent?.trim().slice(0, 2000) || metadata.author };
}
