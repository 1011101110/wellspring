import { describe, expect, it } from 'vitest';
import { RETURN_GAP_DAYS, returnGreeting } from '../src/lib/returnGreeting';

const CHICAGO = 'America/Chicago';
/** A fixed "now": Sunday 2026-07-19, noon Chicago. */
const NOW = new Date('2026-07-19T17:00:00Z');

/** The date key `d` whole days before NOW's calendar day. */
function daysAgo(d: number): string {
  const base = Date.parse('2026-07-19T00:00:00Z');
  return new Date(base - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('returnGreeting', () => {
  it('says nothing to a user who was here recently', () => {
    // A daily/twice-weekly user never crosses the gap, so never sees it —
    // you do not welcome back someone who never left.
    expect(returnGreeting(daysAgo(1), NOW, CHICAGO)).toBeNull();
    expect(returnGreeting(daysAgo(RETURN_GAP_DAYS), NOW, CHICAGO)).toBeNull();
  });

  it('greets a user returning after the gap', () => {
    const greeting = returnGreeting(daysAgo(RETURN_GAP_DAYS + 1), NOW, CHICAGO);
    expect(greeting).not.toBeNull();
    expect(greeting).toMatch(/while|room|whenever/i);
  });

  it('greets on a long absence too', () => {
    expect(returnGreeting(daysAgo(90), NOW, CHICAGO)).not.toBeNull();
  });

  it('says nothing to a first-run user, so the welcome banner shows instead', () => {
    expect(returnGreeting(null, NOW, CHICAGO)).toBeNull();
  });

  /*
   * The assertion this whole feature turns on (Foundation §9, ruling #271).
   * The failure it guards is not a crash — it is a fluent, kind sentence
   * that nonetheless COUNTS ("it's been 2 weeks", "17 days"), which reads
   * as warmth and is exactly the accounting the rule forbids. So: across
   * every gap length that produces a greeting, the greeting must contain no
   * digit and no unit of time.
   */
  it('never contains a number, a date, or a duration — at any gap length', () => {
    for (let d = RETURN_GAP_DAYS + 1; d <= 400; d += 1) {
      const greeting = returnGreeting(daysAgo(d), NOW, CHICAGO);
      if (greeting === null) continue;
      expect(greeting, `greeting at ${d} days away must carry no digit`).not.toMatch(/\d/);
      expect(greeting, `greeting at ${d} days away must not name a duration`).not.toMatch(
        /\b(day|days|week|weeks|month|months|year|years)\b/i,
      );
      // Nor a comparison to the person's past self, which is the other
      // forbidden shape (a verdict rather than a count).
      expect(greeting).not.toMatch(/you (haven|used to|last|missed|usually)/i);
    }
  });

  it('measures the gap in the profile zone, so "today" agrees with the cards', () => {
    // The devotional dated "10 days ago" is exactly at the threshold and
    // must NOT greet; one more day must. A zone slip here would move that
    // boundary by a day and greet a user who was here yesterday-in-Chicago.
    expect(returnGreeting(daysAgo(RETURN_GAP_DAYS), NOW, CHICAGO)).toBeNull();
    expect(returnGreeting(daysAgo(RETURN_GAP_DAYS + 1), NOW, CHICAGO)).not.toBeNull();
  });

  it('does not throw on an unparseable date, it falls silent', () => {
    expect(returnGreeting('not-a-date', NOW, CHICAGO)).toBeNull();
  });
});
