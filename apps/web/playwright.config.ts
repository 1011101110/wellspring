import { defineConfig } from '@playwright/test';

/**
 * Accessibility suite for the dashboard (N5, issue #264).
 *
 * Mirrors `apps/api/playwright.config.ts` (issue #67) rather than
 * inventing a second posture, with one necessary difference: the API's
 * page under test is a pure `(data) => string`, so its specs never
 * navigate anywhere. The dashboard is React, and the defects #264 found
 * were **computed** — a focus ring's painted position, a composited
 * opacity, a `<label>` that never inherited `button { min-height }`.
 * None of those exist until a browser has laid the page out, which is
 * why they survived review of the CSS.
 *
 * So this one does boot a server, and points at `preview.html` — the
 * fixture-driven states page, which makes no network calls and needs no
 * Postgres, no auth, and no seeded account.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    // `--host 127.0.0.1` explicitly: Vite otherwise binds `localhost`,
    // which on a dual-stack machine resolves to ::1 first and leaves the
    // readiness probe below timing out against a server that is running.
    command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173/preview.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'light', use: { browserName: 'chromium', colorScheme: 'light' } },
    // Two of #264's four findings measured WORSE in dark, so a suite that
    // only checked one theme would have called the page clean.
    { name: 'dark', use: { browserName: 'chromium', colorScheme: 'dark' } },
  ],
});
