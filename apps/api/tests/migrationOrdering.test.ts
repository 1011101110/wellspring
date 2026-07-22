/**
 * Guards the one migration failure mode that unit tests, typecheck, lint and
 * the whole CI backend job all pass straight through — and that only shows up
 * at deploy time, after merge, against a database that has already run some of
 * them.
 *
 * What happened (2026-07-18): two agents working in parallel each authored a
 * migration and independently picked the timestamp `1721700000000`. Both PRs
 * were green and both merged. On staging, `preferences-consent-flags-default-true`
 * deployed first and recorded itself. The next deploy carried
 * `preferences-cadence-derived` — same timestamp, but alphabetically earlier —
 * so node-pg-migrate saw an unrun migration ordered *before* an already-run one
 * and refused to proceed:
 *
 *   Not run migration 1721700000000_preferences-cadence-derived is preceding
 *   already run migration 1721700000000_preferences-consent-flags-default-true
 *
 * Six consecutive deploys then failed at the migration step while every CI
 * check stayed green, and `/status` kept returning 200 because Cloud Run
 * continues serving the last good revision. The result was a repo that looked
 * fully shipped and a staging environment stuck several merges in the past.
 *
 * A duplicate timestamp is therefore not a tidiness issue — it is a silent
 * deploy outage with a healthy-looking health check. This test makes it a
 * red PR instead.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** `1721700000000_preferences-cadence-derived.ts` -> `1721700000000` */
function timestampOf(filename: string): string {
  return filename.split('_')[0]!;
}

describe('migration ordering', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort();

  it('has migrations to check (guards against the guard silently passing on an empty dir)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never reuses a timestamp prefix across two migrations', () => {
    const byTimestamp = new Map<string, string[]>();
    for (const file of files) {
      const ts = timestampOf(file);
      byTimestamp.set(ts, [...(byTimestamp.get(ts) ?? []), file]);
    }

    const duplicates = [...byTimestamp.entries()].filter(([, group]) => group.length > 1);

    // Reported with the filenames rather than a bare count: whoever hits this
    // needs to know which one to renumber, and the fix is to move the *unrun*
    // one forward, never to renumber something that may already be recorded in
    // a deployed database's `pgmigrations` table.
    expect(
      duplicates.map(([ts, group]) => `${ts}: ${group.join(', ')}`),
      'Two migrations share a timestamp. Renumber the one that has NOT been deployed yet — renaming an already-run migration makes node-pg-migrate treat it as new and re-run it.',
    ).toEqual([]);
  });

  it('filenames sort into a strictly increasing timestamp order', () => {
    const timestamps = files.map(timestampOf);
    const ascending = [...timestamps].sort();
    // Lexical sort is what node-pg-migrate itself uses, so this asserts the
    // filesystem order and the runner's order agree.
    expect(timestamps).toEqual(ascending);
  });
});
