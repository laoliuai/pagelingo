#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { processPdf } from './process.js';
export async function main(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        source: { type: 'string' },
        'run-dir': { type: 'string' },
        'p0-run': { type: 'string' },
        preview: { type: 'string' },
        python: { type: 'string' },
        katex: { type: 'string' },
        'model-dir': { type: 'string' },
        pages: { type: 'string' },
      },
    });
    if (!values.source || !values['run-dir'])
      throw new Error(
        'Usage: pagelingo-pdf --source FILE --run-dir NEW_DIR [--p0-run DIR] [--preview DIR] [--python FILE] [--katex DIR] [--model-dir DIR] [--pages SELECTION]',
      );
    const result = await processPdf({
      sourcePath: values.source,
      runDir: values['run-dir'],
      p0RunDir: values['p0-run'],
      previewDir: values.preview,
      pythonPath: values.python,
      katexDir: values.katex,
      modelDir: values['model-dir'],
      pages: values.pages,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PDF processing failed'}\n`,
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  process.exitCode = await main();
