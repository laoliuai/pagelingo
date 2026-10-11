const fs = require('node:fs');
const path = require('node:path');
const katex = require(path.resolve(process.argv[2], 'dist/katex.js'));
const items = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = items.map(({ latex, display }) => {
  try {
    return {
      html: katex.renderToString(latex, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
      }),
      error: null,
    };
  } catch (error) {
    return { html: null, error: error.message };
  }
});
process.stdout.write(JSON.stringify(results));
