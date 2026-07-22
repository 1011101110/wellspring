/**
 * `parseFreeBusyRange` — the server-side span limit for
 * `GET /v1/calendar/freebusy` (M1, #255 constraint 3).
 *
 * The route-level consequences (400 status, no Google call) are asserted in
 * `tests/routes/calendarFreeBusy.test.ts`. This file covers the arithmetic
 * and the error taxonomy directly, so a boundary regression names itself
 * instead of surfacing as a mysterious HTTP status two layers up.
 *
 * The limit is compared against `FREEBUSY_MAX_RANGE_DAYS` imported from
 * shared-contracts rather than a literal 45 — docs/07 §3.1 rule 3, "never
 * hand-copy the thing under test". A literal here would keep passing if the
 * constant changed, which is precisely backwards.
 */
import { describe, expect, it } from 'vitest';
import { FREEBUSY_MAX_RANGE_DAYS } from '@kairos/shared-contracts';
import { parseFreeBusyRange } from '../../../src/services/calendar/freeBusyRange.js';

const DAY_MS = 86_400_000;
const BASE = Date.parse('2026-07-01T00:00:00.000Z');

function rangeOf(spanMs: number) {
  return parseFreeBusyRange(new Date(BASE).toISOString(), new Date(BASE + spanMs).toISOString());
}

describe('parseFreeBusyRange — validity', () => {
  it('rejects missing parameters', () => {
    for (const [from, to] of [
      [undefined, undefined],
      ['2026-07-01T00:00:00Z', undefined],
      [undefined, '2026-07-02T00:00:00Z'],
      ['', ''],
    ] as const) {
      const result = parseFreeBusyRange(from, to);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('invalid');
    }
  });

  it('rejects non-string parameters', () => {
    // Fastify will hand through whatever the querystring parser produced;
    // an array (`?from=a&from=b`) is a string[] and must not reach
    // `Date.parse` as an accident.
    const result = parseFreeBusyRange(['2026-07-01T00:00:00Z'], 12345);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid');
  });

  it('rejects unparseable instants', () => {
    const result = parseFreeBusyRange('next tuesday', 'the day after');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid');
  });

  it('rejects an inverted range as its own error, not as "invalid"', () => {
    // Distinct because the remedies differ: a malformed instant is a client
    // formatting bug, an inverted one is a logic bug. Collapsing them makes
    // the 400 message useless.
    const result = parseFreeBusyRange('2026-07-02T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_ascending');
  });

  it('rejects a zero-width range', () => {
    const result = parseFreeBusyRange('2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_ascending');
  });

  it('normalizes accepted instants to UTC ISO strings', () => {
    // Offset instants are legal RFC3339 and Google accepts them, but
    // normalizing means the cache key for "the same range" is one string
    // rather than however many equivalent spellings clients invent.
    const result = parseFreeBusyRange('2026-07-01T00:00:00+02:00', '2026-07-02T00:00:00+02:00');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.range.timeMin).toBe('2026-06-30T22:00:00.000Z');
      expect(result.range.timeMax).toBe('2026-07-01T22:00:00.000Z');
    }
  });
});

describe('parseFreeBusyRange — the span limit', () => {
  it('accepts a single day', () => {
    expect(rangeOf(DAY_MS).ok).toBe(true);
  });

  it('accepts a six-week month grid (42 days)', () => {
    // The widest view M4 plans to render. If this fails, the cap has been
    // set below the feature it exists to serve.
    expect(rangeOf(42 * DAY_MS).ok).toBe(true);
  });

  it('accepts a span exactly at the limit', () => {
    expect(rangeOf(FREEBUSY_MAX_RANGE_DAYS * DAY_MS).ok).toBe(true);
  });

  it('rejects a span one millisecond past the limit', () => {
    // The boundary's comparison operator, isolated. `>` vs `>=` is the
    // whole content of this assertion.
    const result = rangeOf(FREEBUSY_MAX_RANGE_DAYS * DAY_MS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('too_wide');
  });

  it('rejects a year', () => {
    // #255: "A client asking for a year must fail fast, not melt the quota."
    const result = rangeOf(365 * DAY_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('too_wide');
  });

  it('states the actual limit in the rejection message', () => {
    // A calendar UI that grows a new view should learn its ceiling from the
    // failure rather than from a doc it will not read.
    const result = rangeOf(365 * DAY_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(FREEBUSY_MAX_RANGE_DAYS));
  });
});
