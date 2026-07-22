import { defineConfig } from 'vitest/config';

// Root vitest config; each workspace (apps/api, apps/web,
// packages/shared-contracts) also has its own vitest.config.ts scoped to
// its own tests directory.
export default defineConfig({
  test: {
    projects: ['packages/shared-contracts', 'apps/api', 'apps/web'],
  },
});
