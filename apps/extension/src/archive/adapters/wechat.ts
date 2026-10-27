import { isVisible } from '../../dom/selectors';
import { sourceMetadata, originalSourceText, type ArchiveSource } from './blog';
export function wechatSource(document: Document): ArchiveSource {
  const metadata = sourceMetadata(document);
  const root = document.querySelector<HTMLElement>('#js_content');
  if (!root || !isVisible(root) || !root.textContent?.trim()) return { ...metadata, roots: [], kind: 'article', warnings: ['WeChat article is unavailable; login, verification or unloaded content was not expanded.'] };
  const title = document.querySelector<HTMLElement>('#activity-name');
  return { ...metadata, roots: title && !root.contains(title) ? [title, root] : [root], kind: 'article',
    title: originalSourceText(title) || metadata.title,
    author: document.querySelector('#js_name')?.textContent?.trim().slice(0, 2000) || metadata.author };
}
