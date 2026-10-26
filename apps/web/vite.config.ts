import { readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// The worker and all optional PDF decoding resources are served locally.
const pdfRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const resourceDirs = ['cmaps', 'standard_fonts', 'wasm'];
export default defineConfig({
  envDir: false,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'local-pdf-resources',
      async generateBundle() {
        for (const directory of resourceDirs) {
          for (const name of await readdir(join(pdfRoot, directory))) {
            if (name === 'quickjs-eval.wasm') continue;
            this.emitFile({
              type: 'asset',
              fileName: `assets/pdfjs/${directory}/${name}`,
              source: await readFile(join(pdfRoot, directory, name)),
            });
          }
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const match =
            /^\/assets\/pdfjs\/(cmaps|standard_fonts|wasm)\/([a-zA-Z0-9_.-]+)$/.exec(
              request.url ?? '',
            );
          if (!match || match[2] === '.' || match[2] === '..' || match[2] === 'quickjs-eval.wasm') return next();
          response.setHeader(
            'Content-Type',
            match[2].endsWith('.wasm') ? 'application/wasm' : match[2].endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
          );
          const stream = createReadStream(join(pdfRoot, match[1], match[2]));
          stream.on('error', () => {
            response.statusCode = 404;
            response.end();
          });
          stream.pipe(response);
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: Number(process.env.PAGELINGO_VITE_PORT ?? 5174), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.PAGELINGO_SERVICE_PORT ?? 4320}` } },
});
