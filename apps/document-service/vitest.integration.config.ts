import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
