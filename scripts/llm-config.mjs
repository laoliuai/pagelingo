import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Node integration scripts only; the extension never imports this module. */
export function readLlmConfiguration() {
  let local = {};
  try { local = parseEnv(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地联调配置。'); }
  const config = { ...local, ...process.env };
  const baseUrl = config.PAGELINGO_LLM_BASE_URL?.trim();
  const model = config.PAGELINGO_LLM_MODEL?.trim();
  if (!baseUrl || !model) throw new Error('请配置 PAGELINGO_LLM_BASE_URL 和 PAGELINGO_LLM_MODEL。');
  return { baseUrl, model, apiKey: config.PAGELINGO_LLM_API_KEY?.trim() ?? '', responseFormat: config.PAGELINGO_LLM_RESPONSE_FORMAT ?? 'json-object' };
}
