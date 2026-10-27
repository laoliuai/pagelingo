import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { readerIrShapeSchema } from '../dist/reader.js';
import { readerTranslationShapeSchema } from '../dist/reader-translation.js';
import { documentBundleManifestShapeSchema } from '../dist/bundle.js';

for (const [name, schema] of [
  ['reader-ir', readerIrShapeSchema],
  ['reader-translation', readerTranslationShapeSchema],
  ['document-bundle', documentBundleManifestShapeSchema],
]) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  jsonSchema.$id = `https://pagelingo.dev/schemas/${name}/1`;
  jsonSchema.$comment = 'Shape validation only. Reader graph, translation references, SDK replay, resource closure and actual byte hashes require their dedicated validators.';
  writeFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), `${JSON.stringify(jsonSchema, null, 2)}\n`);
}
