import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Node 24 strips types; resolve source ESM .js imports to their .ts files so this
// isolated timeout probe exercises current source without a stale dist build.
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(source))) return { url: source.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { safeMathAstSchema } = await import('../src/index.ts');
const ast = transform => ({
  kind: 'svg', roots: ['root'],
  nodes: [{ id: 'root', tag: 'svg', attributes: { transform }, children: [] }],
});
let accepts = transform => safeMathAstSchema.safeParse(ast(transform)).success;
if (process.argv[2] === 'json-schema') {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const { ir } = await import('./web-fixtures.ts');
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../schemas/web-reader-ir.schema.json', import.meta.url), 'utf8')));
  accepts = transform => validate({
    ...ir,
    blocks: [{ ...ir.blocks[0], type: 'math', latex: null, ast: ast(transform), displayMode: true }],
  });
}
const invalid = [
  'translate(1)     '.repeat(12) + '!',
  'translate(1)     '.repeat(1000) + '!',
  String.raw`translate(1) u\72l(https://example.com/paint)`,
];
const valid = [
  'translate(1)',
  'translate(1)     scale(2)',
  '   matrix(1, 0, 0, 1, 2, 3)    rotate(45)   ',
  'translate(1)scale(2)',
];
process.stdout.write(JSON.stringify({ invalid: invalid.map(accepts), valid: valid.map(accepts) }));
