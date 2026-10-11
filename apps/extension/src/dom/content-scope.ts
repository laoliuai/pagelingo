import { BLOCK_SELECTOR, findContentRoot, isExcluded, isVisible } from './selectors';

export interface ContentScope {
  roots: HTMLElement[];
  blockSelector: string;
  keepSource: boolean;
}

const X_RICH_TEXT = '[data-testid="twitterArticleRichTextView"],[data-testid="longformRichTextComponent"],[data-testid="articleRichContent"]';
const X_READER = '[data-testid="twitterArticleReadView"],[data-testid="articleViewer"],[data-testid="twitterArticleReader"]';
const X_TITLE = '[data-testid="twitter-article-title"],[data-testid="articleTitle"],[data-testid="twitterArticleTitle"]';
const X_BLOCKS = `${BLOCK_SELECTOR},[role="heading"],[data-block="true"],.longform-unstyled,.public-DraftStyleDefault-block`;
const X_POST = 'article[data-testid="tweet"]';
const X_QUOTE = '[data-testid="quoteTweet"],[data-testid="quotedTweet"],[data-testid="simpleTweet"],[data-testid="card.wrapper"]';

function available(element: HTMLElement): boolean {
  return !element.closest(X_QUOTE) && !isExcluded(element) && isVisible(element);
}

function statusId(url: URL): string | undefined {
  return url.pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1];
}

/** Site scopes keep extraction and source-change detection on the same content. */
export function findContentScope(document: Document): ContentScope {
  const primary = document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');
  const url = new URL(document.URL);
  const xStructure = primary?.querySelector(`${X_POST},${X_READER},${X_RICH_TEXT}`);
  if (!xStructure && !/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) {
    return { roots: [findContentRoot(document)], blockSelector: BLOCK_SELECTOR, keepSource: false };
  }

  const container = primary ?? document.body;
  const requestedId = statusId(url);
  const posts = Array.from(container.querySelectorAll<HTMLElement>(X_POST)).filter(available);
  const requestedPost = requestedId ? posts.find(post => Array.from(post.querySelectorAll<HTMLAnchorElement>('a[href]')).some(link => {
    // A quote or a link in the text must not identify the containing post.
    if (link.closest(X_POST) !== post || link.closest(`${X_QUOTE},[data-testid="tweetText"]`) || !link.querySelector('time')) return false;
    try { return statusId(new URL(link.href, document.baseURI)) === requestedId; } catch { return false; }
  })) : undefined;
  const richText = Array.from(container.querySelectorAll<HTMLElement>(X_RICH_TEXT)).find(element => {
    if (!available(element)) return false;
    const post = element.closest(X_POST);
    // A standalone reader belongs to this route; embedded rich text must
    // belong to the requested post, not a reply loaded alongside it.
    return !requestedId || !post || post === requestedPost;
  });
  if (richText) {
    const reader = richText.closest<HTMLElement>(X_READER) ?? richText.closest<HTMLElement>(X_POST) ?? container;
    const title = Array.from(reader.querySelectorAll<HTMLElement>(X_TITLE)).find(available);
    // Counters, author information, navigation and replies are outside these roots.
    return { roots: title && !richText.contains(title) ? [title, richText] : [richText], blockSelector: `${X_BLOCKS},${X_TITLE}`, keepSource: true };
  }
  const selectedPosts = requestedId ? requestedPost ? [requestedPost] : [] : posts;
  const roots = selectedPosts.flatMap(post => {
    const text = Array.from(post.querySelectorAll<HTMLElement>('[data-testid="tweetText"]')).find(element =>
      element.closest(X_POST) === post && available(element));
    return text ? [text] : [];
  });
  // An unloaded status must not fall back to translating a different reply.
  return { roots, blockSelector: `${BLOCK_SELECTOR},[data-testid="tweetText"]`, keepSource: true };
}

export function headingLevel(element: HTMLElement): number | undefined {
  if (/^H[1-6]$/.test(element.tagName)) return Number(element.tagName[1]);
  if (element.matches(X_TITLE)) return 1;
  if (element.getAttribute('role') === 'heading') {
    const level = Number(element.getAttribute('aria-level') ?? 2);
    return level >= 1 && level <= 6 ? level : 2;
  }
  return undefined;
}
