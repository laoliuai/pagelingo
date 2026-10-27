import { expect, it } from 'vitest';
import { classifyDocumentLink } from '../../src/web-captures/links.js';
it('matches exact login routes without matching technical article words', () => {
  expect(classifyDocumentLink('https://example.com/account/login').reason).toBe('BROWSER_CAPTURE_REQUIRED');
  expect(classifyDocumentLink('https://example.com/blog/authentication-and-login-design').reason).toBeNull();
  expect(classifyDocumentLink('https://example.com/blog/authors')).toEqual({ kind: 'article', reason: null });
});
