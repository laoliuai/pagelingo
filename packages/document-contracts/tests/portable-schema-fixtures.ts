import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export function portable(name: string) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')));
}
