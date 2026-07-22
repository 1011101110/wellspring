import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the session-page accessibility suite (issue #67).
 * Deliberately narrow scope: `e2e/` specs render `renderSessionPage.ts`'s
 * real HTML output directly via `page.setContent()` rather than booting a
 * live server + Postgres + seeded session — the function under test is
 * pure (`(data: SessionPageData) => string`), so this exercises the exact
 * same markup/CSS a real `GET /session/:token` response would produce,
 * with none of the live-dependency setup a real HTTP round-trip would
 * need. See e2e/sessionPage.a11y.spec.ts's header comment for the
 * rationale in full.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    // No baseURL/webServer — every spec loads content directly via
    // page.setContent(), never navigates to a real URL.
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
