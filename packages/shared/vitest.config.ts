import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // integration tests boot a real Postgres claim path; give them room
    testTimeout: 30000,
    hookTimeout: 60000,
    // LOAD-BEARING, not just a perf choice: each integration file's afterAll
    // calls closeTestDb(), which destroys the harness's module-global pool. Files
    // must run serially so file N fully closes the pool before file N+1 re-creates
    // it via getTestDb(). Do NOT flip this to true without moving the pool lifecycle
    // into a vitest globalSetup/globalTeardown first, or file A's teardown will
    // yank the pool out from under file B mid-test.
    fileParallelism: false,
  },
});
