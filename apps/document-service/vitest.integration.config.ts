import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    // Random schemas still share database-wide publication/admin advisory locks.
    // Keep files sequential; explicit multi-process worker tests retain concurrency.
    fileParallelism: false,
    include: ['tests/integration/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
