export const htmlTags = new Set('article section main div p span h1 h2 h3 h4 h5 h6 blockquote aside header footer nav ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption pre code strong b em i a sub sup del s small mark u br hr img abbr time'.split(' '));
export const forbidden = new Set('script style iframe frame frameset object embed form input textarea select option button meta base link template noscript canvas audio video source track'.split(' '));

export const containerTags = new Set('article section main div blockquote aside header footer nav ul ol li dl dt dd table thead tbody tfoot tr th td figure'.split(' '));
export const structuralTags = new Set([...containerTags, ...'p h1 h2 h3 h4 h5 h6 pre caption figcaption hr'.split(' ')]);
/** Elements outside the allow-list that have a safe equivalent. Everything else keeps its children and loses only its tag. */
export const renamedTags = new Map(Object.entries({
  kbd: 'code', samp: 'code', tt: 'code', var: 'code', strike: 's', acronym: 'abbr', xmp: 'pre', listing: 'pre', plaintext: 'pre',
  center: 'div', address: 'div', details: 'div', summary: 'div', hgroup: 'div', search: 'div', fieldset: 'div', legend: 'div', menu: 'ul', dir: 'ul',
}));
/** Page metadata and fallback for other browsers, never reading content. */
export const droppedTags = new Set('title noembed noframes dialog'.split(' '));
/** Omitting these loses content a reader would have seen. Controls and hidden elements do not. */
export const embeddedContentTags = new Set('iframe frame frameset object embed canvas audio video'.split(' '));
/** Dollars in these elements are literal text, never formula delimiters. */
export const literalTextTags = new Set('pre code kbd samp tt var xmp listing plaintext script style textarea math svg title noscript noembed noframes template'.split(' '));
/** Children an inline SVG can lose without changing what it draws. None of them were ever valid in a saved formula. */
export const decorativeSvgTags = new Set('style title desc metadata script'.split(' '));
