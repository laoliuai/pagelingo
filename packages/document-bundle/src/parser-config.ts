import { check } from './errors.js';
export interface ParserConfig {
  schemaVersion: 'pagelingo-parser-config/1';
  parser: { name: string; version: string | null };
  options: {
    tier?: 'basic' | 'standard' | 'enhanced';
    smallBackend?: string;
    device?: string;
    parseMode?: string;
    imageAnalysis?: boolean;
    vlm?: boolean;
    pageRange?: string;
    threadsRequested?: number;
    onnxIntraOpThreadsRequested?: number;
    onnxInterOpThreadsRequested?: number;
  };
}
const optionKeys = new Set([
  'tier',
  'smallBackend',
  'device',
  'parseMode',
  'imageAnalysis',
  'vlm',
  'pageRange',
  'threadsRequested',
  'onnxIntraOpThreadsRequested',
  'onnxInterOpThreadsRequested',
]);
/** Versioned positive allowlist. Producers select fields; never spread runtime configuration. */
export function parseParserConfig(value: unknown): ParserConfig {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const config = value as Record<string, unknown>;
  check(
    Object.keys(config).length === 3 &&
      config.schemaVersion === 'pagelingo-parser-config/1',
  );
  check(
    config.parser &&
      typeof config.parser === 'object' &&
      !Array.isArray(config.parser),
  );
  const parser = config.parser as Record<string, unknown>;
  check(
    Object.keys(parser).length === 2 &&
      typeof parser.name === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(parser.name),
  );
  check(
    parser.version === null ||
      (typeof parser.version === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(parser.version)),
  );
  check(
    config.options &&
      typeof config.options === 'object' &&
      !Array.isArray(config.options),
  );
  for (const [key, option] of Object.entries(config.options)) {
    check(optionKeys.has(key));
    if (key === 'imageAnalysis' || key === 'vlm')
      check(typeof option === 'boolean');
    else if (key.endsWith('ThreadsRequested') || key === 'threadsRequested')
      check(Number.isSafeInteger(option) && (option as number) > 0);
    else if (key === 'tier')
      check(['basic', 'standard', 'enhanced'].includes(option as string));
    else if (key === 'pageRange')
      check(
        typeof option === 'string' &&
          option.length <= 2000 &&
          /^(?:all|[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)$/.test(option),
      );
    else
      check(
        typeof option === 'string' &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(option),
      );
  }
  return value as ParserConfig;
}
