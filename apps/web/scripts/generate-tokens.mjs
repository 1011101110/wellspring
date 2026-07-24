/**
 * Regenerates src/tokens.css from the design-token source of truth (T1, #348).
 *
 *   npm run tokens --workspace=apps/web
 *
 * The output is CHECKED IN rather than emitted at build time, so the dev
 * server, the production build, and the Playwright suites all read one file
 * with no generation step in their path. The drift test
 * (test/designTokens.test.ts) fails whenever the file and the TS literal
 * disagree, which is what makes checking it in safe.
 *
 * Requires the contracts to be built first (`npm run build
 * --workspace=packages/shared-contracts`) — same prerequisite as the web
 * build itself.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wellspringTokensCss } from '@kairos/shared-contracts';

// Silent on success, loud on failure (writeFileSync throws) — the repo's
// eslint config declares no Node globals, so there is no `console` here.
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tokens.css');
writeFileSync(out, wellspringTokensCss());
