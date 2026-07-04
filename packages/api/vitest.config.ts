import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    // same rationale as packages/shared/vitest.config.ts — the (shared) test
    // harness pool lifecycle is torn down per-file in afterAll, so files must
    // run serially.
    fileParallelism: false,
  },
});
