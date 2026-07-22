import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Multiple test files share one Postgres container (kairos-test-pg,
    // A5 convention) and each does `TRUNCATE ... RESTART IDENTITY CASCADE`
    // in beforeEach — running files in parallel worker processes races
    // those truncates against each other's in-flight assertions. Disabling
    // file parallelism keeps DB-backed suites (tests/db/repositories.test.ts,
    // tests/routes/session.integration.test.ts) correct; pure-unit files
    // are fast enough that running the whole suite sequentially is not a
    // meaningful cost here.
    fileParallelism: false,
  },
});
