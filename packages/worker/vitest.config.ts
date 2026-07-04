import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    // same rationale as packages/shared/vitest.config.ts: the (shared)
    // harness pool lifecycle is torn down per-file in afterAll, so files
    // must run serially. See that file's comment for the full explanation.
    fileParallelism: false,
  },
});
