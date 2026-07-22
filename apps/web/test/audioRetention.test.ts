import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_RETENTION_DAYS,
  NOTICE_WINDOW_DAYS,
  audioExpiryNotice,
  audioLifetime,
} from '../src/lib/audioRetention';
import { formatCalendarDate } from '../src/lib/datetime';

const DEVOTIONAL_DAY = '2026-07-01';
/** Expiry lands on 2026-07-15 (1 July + 14 days). */
const at = (iso: string) => new Date(iso);

describe('audioLifetime', () => {
  it('says nothing while expiry is comfortably away', () => {
    // A notice under every devotional from the moment it exists is
    // furniture, and starts to read as a deadline the user is measured
    // against (docs/14 §5.10).
    expect(audioLifetime(DEVOTIONAL_DAY, at('2026-07-02T12:00:00Z')).kind).toBe('silent');
  });

  it('speaks up inside the notice window, naming the date', () => {
    const life = audioLifetime(DEVOTIONAL_DAY, at('2026-07-13T12:00:00Z'));
    expect(life).toEqual({ kind: 'expiring', on: '2026-07-15' });
  });

  it('reports expired once the window has passed', () => {
    expect(audioLifetime(DEVOTIONAL_DAY, at('2026-07-16T00:00:00Z')).kind).toBe('expired');
  });

  it('treats the boundary as still available, not already gone', () => {
    // Exactly at the cutoff instant. Rounding this to `expired` would tell
    // a user their audio is gone while the purge sweep has not run and the
    // player would still work — a false claim in the cautious direction is
    // still a false claim.
    const life = audioLifetime(DEVOTIONAL_DAY, at('2026-07-14T23:59:00Z'));
    expect(life.kind).toBe('expiring');
  });

  it('stays silent rather than guessing when the date is unparseable', () => {
    expect(audioLifetime('not-a-date', at('2026-07-13T12:00:00Z')).kind).toBe('silent');
  });

  it('derives the date in UTC, matching how the sweep actually deletes', () => {
    // #209: a calendar day and an instant are both `string`, and reading
    // this one in local time would name a date a day off from the one the
    // global UTC-cutoff purge job uses. The user would be told the wrong
    // day by the app that deletes it.
    const life = audioLifetime(DEVOTIONAL_DAY, at('2026-07-13T23:30:00Z'));
    expect(life).toMatchObject({ on: '2026-07-15' });
  });
});

describe('audioExpiryNotice', () => {
  it('is silent unless the audio is actually expiring', () => {
    expect(audioExpiryNotice({ kind: 'silent' }, formatCalendarDate)).toBeNull();
    expect(audioExpiryNotice({ kind: 'expired' }, formatCalendarDate)).toBeNull();
  });

  it('states the date and carries no count, urgency, or instruction', () => {
    const notice = audioExpiryNotice({ kind: 'expiring', on: '2026-07-15' }, formatCalendarDate)!;
    expect(notice).toContain(formatCalendarDate('2026-07-15'));
    // §9: no accounting. A "3 days left" here would be a small clock over
    // a devotional, which is exactly the thing this product refuses.
    expect(notice).not.toMatch(/\d+\s*(day|days|hours)/i);
    expect(notice).not.toMatch(/hurry|don.t lose|last chance|expires soon|act now/i);
  });
});

describe('the two retention constants must not drift', () => {
  it('agrees with DEVOTIONAL_AUDIO_RETENTION_DAYS in the API purge job', () => {
    /*
     * `AUDIO_RETENTION_DAYS` is duplicated in the web client because
     * apps/web does not depend on apps/api and inventing that dependency
     * for one integer would be worse than the copy. But a duplicated
     * constant with no check is a promise waiting to be broken silently —
     * the app would go on naming a date the sweep no longer honours.
     *
     * So this reads the API source and compares. It is deliberately NOT a
     * hand-written `expect(14)`: that would agree with a stale copy on
     * both sides at once, which is precisely the #253 shape.
     */
    const source = readFileSync(
      new URL('../../api/src/services/retention/purgeJobs.ts', import.meta.url),
      'utf8',
    );
    const match = source.match(/DEVOTIONAL_AUDIO_RETENTION_DAYS\s*=\s*(\d+)/);
    expect(match, 'could not find the API constant — did it get renamed?').not.toBeNull();
    expect(Number(match![1])).toBe(AUDIO_RETENTION_DAYS);
  });

  it('notices sooner than it deletes', () => {
    expect(NOTICE_WINDOW_DAYS).toBeLessThan(AUDIO_RETENTION_DAYS);
  });
});
