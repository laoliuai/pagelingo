import type { Page } from '@playwright/test';
export type OfflineDiagnostic = { kind: string; message: string; classification: 'expected-sandbox' | 'unexpected' };
/** Only the opaque, script-disabled file preview warning is expected. Errors stay visible. */
export function collectOfflineDiagnostics(page: Page) {
  const diagnostics: OfflineDiagnostic[] = [];
  const record = (kind: string, message: string) => {
    const preview = message.match(/^Blocked script execution in '(file:\/\/\/[^'\r\n]+)' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/);
    const expectedRoot = page.url().startsWith('file:') ? new URL('previews/', page.url()).href : null;
    const expected = kind === 'console:error' && !!preview && !!expectedRoot && preview[1].startsWith(expectedRoot)
      && /\/p_[a-zA-Z0-9_]+\.html$/.test(new URL(preview[1]).pathname);
    diagnostics.push({ kind, message, classification: expected ? 'expected-sandbox' : 'unexpected' });
  };
  page.on('console', message => { if (message.type() === 'error') record('console:error', message.text()); });
  page.on('pageerror', error => record('pageerror', error.message));
  return { diagnostics, unexpected: () => diagnostics.filter(item => item.classification === 'unexpected') };
}
