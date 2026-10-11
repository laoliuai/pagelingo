import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { chatCompletionsUrl } from '@pagelingo/translation-core';
import { readLlmConfiguration } from '../../../../scripts/llm-config.mjs';

// Opt-in, billable integration. No traces, request payload logs or settings screenshots.
const extensionDist = fileURLToPath(new URL('../../dist/', import.meta.url));
let temporary;
let context;
try {
  const config = readLlmConfiguration();
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const targetUrl = new URL(process.argv[2] ?? 'https://api-docs.deepseek.com/guides/json_mode/');
  assert.ok(['https:', 'http:'].includes(targetUrl.protocol), 'Target must be an HTTP/HTTPS article.');
  function checkArtifacts(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) checkArtifacts(fullPath);
      else if (config.apiKey && readFileSync(fullPath).includes(Buffer.from(config.apiKey))) throw new Error('构建产物含有本地密钥。');
    }
  }
  checkArtifacts(extensionDist);
  temporary = mkdtempSync(path.join(tmpdir(), 'pagelingo-live-'));
  const extension = path.join(temporary, 'extension');
  cpSync(extensionDist, extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hostPattern = (url) => `${url.protocol}//${url.hostname}/*`;
  // Headless cannot approve native activeTab / permission bubbles. Only this temporary
  // test copy has pre-granted access to the target and the configured API host.
  manifest.host_permissions = [...new Set([hostPattern(targetUrl), hostPattern(new URL(endpoint))])];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  let requests = 0;
  context.on('request', (request) => { if (request.url() === endpoint && request.method() === 'POST') requests++; });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await expect(control.getByRole('button', { name: '保存设置' })).toBeEnabled();
  await control.evaluate(async (config) => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.local.set({ settings: { schemaVersion: 1, ...config, temperature: 0.1,
      targetLanguage: 'zh-CN', displayMode: 'bilingual', customGlossary: [], maxOutputTokens: 4096,
      maxTokensParameter: 'max_tokens', thinkingMode: 'auto',
    } });
  }, config);
  await control.reload();
  await control.getByRole('button', { name: '授权并测试连接' }).click();
  await expect(control.getByRole('status')).toContainText('连接成功', { timeout: 28_000 });
  const page = await context.newPage();
  await page.goto(targetUrl.href, { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('article, main').first()).toBeVisible();
  const before = await page.locator('article, main').first().innerHTML();
  async function command(value) {
    const result = await control.evaluate(async ({ url, command }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === url);
      if (tab?.id === undefined) throw new Error('找不到目标标签页。');
      return chrome.runtime.sendMessage({ type: 'extension:command', tabId: tab.id, command });
    }, { url: page.url(), command: value });
    if (!result?.ok) throw new Error(result?.error ?? '扩展没有响应。');
    return result.value;
  }
  const started = performance.now();
  let status = await command({ type: 'page:translate', mode: 'bilingual' });
  const deadline = performance.now() + 120_000;
  while (!['completed', 'partial', 'error', 'stale'].includes(status.status) && performance.now() < deadline) {
    await page.waitForTimeout(150);
    status = await command({ type: 'page:status' });
  }
  assert.equal(status.status, 'completed', status.error ?? '真实页面翻译未完成。');
  assert.ok(status.total > 0 && status.completed === status.total && status.failed === 0, '存在未完成的文本块。');
  const translations = await page.locator('[data-pl-owned="translation"]').allTextContents();
  assert.equal(translations.length, status.completed);
  assert.ok(translations.some((text) => /\p{Script=Han}/u.test(text)), '没有找到中文译文。');
  assert.ok(translations.every((text) => !text.includes('【布局预览】')), '出现 Mock 结果。');
  const elapsedMs = Math.round(performance.now() - started);
  await command({ type: 'page:mode', mode: 'translation' });
  await command({ type: 'page:mode', mode: 'source' });
  await command({ type: 'page:restore' });
  assert.equal(await page.locator('article, main').first().innerHTML(), before, '正文未完整恢复。');
  const firstPassRequests = requests;
  const cachedStarted = performance.now();
  status = await command({ type: 'page:translate', mode: 'bilingual' });
  while (!['completed', 'partial', 'error', 'stale'].includes(status.status) && performance.now() - cachedStarted < 30000) {
    await page.waitForTimeout(100); status = await command({ type: 'page:status' });
  }
  assert.equal(status.status, 'completed', '第二次真实页面翻译未完成。');
  assert.equal(requests, firstPassRequests, '缓存重放产生了新的 API 请求。');
  assert.equal(status.metrics?.cacheHits, status.total, '整页没有全部命中缓存。');
  const cachedElapsedMs = Math.round(performance.now() - cachedStarted);
  await command({ type: 'page:restore' });
  assert.equal(await page.locator('article, main').first().innerHTML(), before, '缓存重放后正文未完整恢复。');
  console.log(JSON.stringify({ model: config.model, page: page.url(), completed: status.completed, elapsedMs, requests,
    cachedElapsedMs, cacheHits: status.metrics.cacheHits, secondPassRequests: requests - firstPassRequests,
    sample: translations.slice(0, 3), validation: '真实页面 → DOM 提取 → 后台 SDK → 真实 API → 结构校验 → 安全回填 → 模式切换 → 原文恢复通过；构建产物不含本地 Key。',
  }, null, 2));
} catch (error) {
  // Do not print Playwright call logs: those can contain field values or RPC arguments.
  console.error(error instanceof Error ? error.message.split('\n')[0] : '真实扩展联调失败。');
  process.exitCode = 1;
} finally {
  await context?.close();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
