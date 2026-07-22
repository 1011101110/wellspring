import { defineConfig } from 'vitest/config';

// Scoped to this workspace's own tests, matching apps/api and
// packages/shared-contracts. The root config lists this as a project.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
