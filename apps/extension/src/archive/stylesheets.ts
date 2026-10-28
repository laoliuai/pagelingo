import { captureUrlSchema, defaultCaptureLimits, type PendingCaptureResource } from '@pagelingo/document-contracts';

/** Original stylesheet evidence only. CSS is archived as data and never applied to previews. */
export function collectOriginalStylesheets(document: Document, sourceUrl: string) {
  const resources: PendingCaptureResource[] = [];
  const warnings = new Set<string>();
  const walker = document.createTreeWalker(document.documentElement, 1);
  let visited = 0;
  let index = 0;
  let textBytes = 0;
  let node: Node | null = document.documentElement;
  while (node) {
    if (++visited > defaultCaptureLimits.maxDomNodes) {
      warnings.add('Stylesheet discovery exceeded the document node budget; remaining stylesheets are unavailable.');
      break;
    }
    const element = node as Element;
    if (!element.closest('[data-pl-owned]') && element.matches('style,link[rel~="stylesheet"]')) {
      if (index >= defaultCaptureLimits.maxFiles - 1) {
        warnings.add('Stylesheet discovery exceeded the resource count budget; remaining stylesheets are unavailable.');
        break;
      }
      const id = `css-${index}`;
      const type = element.getAttribute('type')?.trim().toLowerCase();
      if (element.localName === 'style') {
        const identity = { id, role: 'css' as const, url: null, provenance: { kind: 'inline-style' as const, documentUrl: sourceUrl, index } };
        if (type && type !== 'text/css') resources.push({ ...identity, missingReason: 'unsupported' });
        else {
          try {
            const text = element.textContent ?? '';
            const bytes = new TextEncoder().encode(text).byteLength;
            const serializedBytes = new TextEncoder().encode(JSON.stringify(text)).byteLength;
            if (bytes > defaultCaptureLimits.maxResourceBytes || textBytes + serializedBytes > defaultCaptureLimits.maxIrBytes) {
              resources.push({ ...identity, missingReason: 'too-large' });
            } else {
              resources.push({ ...identity, text }); textBytes += serializedBytes;
            }
          } catch { resources.push({ ...identity, missingReason: 'unavailable' }); }
        }
      } else {
        try {
          const href = element.getAttribute('href');
          if (!href) throw Error('not-loaded');
          const url = new URL(href, document.baseURI).href;
          if (!captureUrlSchema.safeParse(url).success) throw Error('unsupported');
          resources.push({ id, role: 'css', url, ...(type && type !== 'text/css' ? { missingReason: 'unsupported' as const } : {}) });
        } catch {
          warnings.add('Unsupported or unavailable stylesheet locator was omitted; only HTTP(S) external CSS can be archived.');
        }
      }
      index++;
    }
    node = walker.nextNode();
  }
  if (document.adoptedStyleSheets?.length) warnings.add('Unsupported constructed stylesheets have no original style element and were not archived.');
  for (const resource of resources) if ('missingReason' in resource && resource.missingReason) warnings.add(`Stylesheet ${resource.id} missing: ${resource.missingReason}.`);
  return { resources, warnings: [...warnings] };
}
