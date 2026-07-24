import { defineConfig } from 'vitest/config';

// Scoped to this workspace's own tests, matching apps/api and
// packages/shared-contracts. The root config lists this as a project.
//
// The default environment stays `node` — most of this suite is pure
// functions from src/lib. Component regression tests (App.test.tsx)
// opt into jsdom per-file with a `@vitest-environment jsdom` docblock
// rather than making every pure test pay for a DOM.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
