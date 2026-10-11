import { pageStatusSchema, type PageCommand, type PageStatus, type Result } from './types';
import type { UserSettings } from '../settings/schema';
import { z } from 'zod';

const connectionResultSchema = z.object({ model: z.string(), elapsedMs: z.number().nonnegative(), sample: z.string() });
export async function testLlmConnection(settings: UserSettings) {
  const result = await chrome.runtime.sendMessage({ type: 'extension:test-connection', settings }) as Result<unknown> | undefined;
  if (!result) throw new Error('扩展后台没有响应，请重新加载扩展。');
  if (!result.ok) throw new Error(result.error);
  return connectionResultSchema.parse(result.value);
}

export async function sendPageCommand(tabId: number, command: PageCommand): Promise<PageStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Result<unknown> | undefined;
  try {
    result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'extension:command', tabId, command }) as Promise<Result<unknown> | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('页面暂时没有响应，请刷新页面或重新加载扩展。')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!result) throw new Error('扩展没有响应，请重新加载扩展。');
  if (!result.ok) throw new Error(result.error);
  return pageStatusSchema.parse(result.value);
}
