import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  envDir: false,
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5174, proxy: { '/api': 'http://127.0.0.1:4320' } },
});
