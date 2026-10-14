import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

export default defineConfig({
  envDir: false,
  plugins: [react(), crx({ manifest })],
  build: { sourcemap: true },
});
