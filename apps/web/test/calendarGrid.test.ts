/**
 * The calendar view's logic (M2–M5, #255).
 *
 * ## Fixtures are built by the contract, not by hand (docs/07 §3.1)
 *
 * Every free/busy fixture below goes through `FreeBusyResponseSchema.parse`
 * rather than being written as a literal and asserted against. That is the
 * rule's first item — "build the fixture from the shared contract" — and it
 * is load-bearing here specifically: the thing under test is a
 * discriminated union whose `ok` variant alone carries `busy`, and a
 * hand-written fixture would happily include `busy` on a
 * `consent_disabled` object that the real server can never produce. The
 * suite would then agree with a client that reads it.
 *
 * `parse` also strips unknown keys, which is what makes
 * `'busy' in degraded === false` an assertion about the contract rather
 * than about this file.
 *
 * ## Zones
 *
 * Chicago and Sydney, the pair `datetime.test.ts` already uses — far
 * enough apart that a UTC-based implementation lands on the wrong calendar
 * day in at least one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  FreeBusyResponseSchema,
  FREEBUSY_MAX_RANGE_DAYS,
  type FreeBusyData,
  type UpcomingCalendarEvent,
} from '@kairos/shared-contracts';
import {
  answersRange,
  axisReferenceKey,
  busySegmentsForDay,
  eventsInRange,
  gridRange,
  hourRows,
  isDstTransitionDay,
  kairosSegmentsForDay,
  mergeBusy,
  monthCells,
  monthLabel,
  periodLabel,
  rangeContainsDay,
  resolveBusy,
  shiftAnchor,
  unknownBusyMessage,
} from '../src/lib/calendarGrid';
import { addDays, dayLengthMs, dayStartInstant, zonedTimeToInstant } from '../src/lib/datetime';

const CHICAGO = 'America/Chicago';
const SYDNEY = 'Australia/Sydney';

/**
 * 2026 DST in Chicago. Spring forward is the second Sunday in March
 * (2026-03-08, a 23-hour day); fall back is the first Sunday in November
 * (2026-11-01, a 25-hour day). Both are deterministic dates in the IANA
 * database, so nothing here depends on the machine's clock or locale.
 */
const SPRING_FORWARD = '2026-03-08';
const FALL_BACK = '2026-11-01';

// --- fixture builders (contract-anchored) -----------------------------

function freeBusyFixture(raw: unknown): FreeBusyData {
  return FreeBusyResponseSchema.parse(raw).data;
}

function okFixture(
  range: { from: string; to: string; timeZone: string },
  busy: { start: string; end: string }[],
): FreeBusyData {
  return freeBusyFixture({ ok: true, data: { status: 'ok', range, busy } });
}

function degradedFixture(
  status: 'consent_disabled' | 'not_connected',
  range: { from: string; to: string; timeZone: string },
): FreeBusyData {
  return freeBusyFixture({ ok: true, data: { status, range } });
}

function kairosEvent(
  id: string,
  gapStartAt: string,
  gapEndAt: string,
  theme: string | null = 'Rest',
): UpcomingCalendarEvent {
  return {
    id,
    gapStartAt,
    gapEndAt,
    meetUri: null,
    rescheduleCount: 0,
    devotional: theme === null ? null : { id: `d-${id}`, theme, cardSummary: 'A summary.' },
  };
}

// --- range ------------------------------------------------------------

describe('gridRange', () => {
  it('bounds a day with that day’s real midnights in the profile zone', () => {
    const range = gridRange('day', '2026-07-19', CHICAGO);
    expect(range.dayKeys).toEqual(['2026-07-19']);
    // CDT is UTC-5 in July, so the Chicago day starts at 05:00Z — not at
    // 00:00Z, which is what a browser-zone or UTC implementation sends.
    expect(range.from).toBe('2026-07-19T05:00:00.000Z');
    expect(range.to).toBe('2026-07-20T05:00:00.000Z');
  });

  it('bounds the same day differently in a different zone', () => {
    const range = gridRange('day', '2026-07-19', SYDNEY);
    // AEST is UTC+10 in July, so the Sydney day begins the previous
    // afternoon in UTC. The cell key is identical; the instants are not.
    expect(range.from).toBe('2026-07-18T14:00:00.000Z');
    expect(range.to).toBe('2026-07-19T14:00:00.000Z');
  });

  it('starts the week on Sunday, matching the activeDays convention', () => {
    // 2026-07-22 is a Wednesday.
    const range = gridRange('week', '2026-07-22', CHICAGO);
    expect(range.dayKeys).toHaveLength(7);
    expect(range.dayKeys[0]).toBe('2026-07-19'); // Sunday
    expect(range.dayKeys[6]).toBe('2026-07-25'); // Saturday
  });

  it('builds a 42-cell month grid starting on the Sunday on or before the 1st', () => {
    // 2026-07-01 is a Wednesday, so the grid opens on Sunday 2026-06-28.
    const range = gridRange('month', '2026-07-15', CHICAGO);
    expect(range.dayKeys).toHaveLength(42);
    expect(range.dayKeys[0]).toBe('2026-06-28');
    expect(range.dayKeys[41]).toBe('2026-08-08');
  });

  it('never asks for more than the server will accept', () => {
    // The 45-day cap is our own quota protection and is enforced
    // server-side with a 400 — a client that exceeds it gets an error
    // page, not a wide calendar. Checked across a year of anchors rather
    // than one, since the month grid's span is fixed but its edges move.
    for (let month = 1; month <= 12; month += 1) {
      const anchor = `2026-${String(month).padStart(2, '0')}-15`;
      for (const zone of [CHICAGO, SYDNEY]) {
        const range = gridRange('month', anchor, zone);
        expect(range.dayKeys.length).toBeLessThanOrEqual(FREEBUSY_MAX_RANGE_DAYS);
        const spanDays = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
        expect(spanDays).toBeLessThanOrEqual(FREEBUSY_MAX_RANGE_DAYS);
      }
    }
  });

  it('spans a real number of hours across a DST boundary, not a rounded one', () => {
    // The March grid contains the spring-forward day, so its span is 42
    // days MINUS an hour. An implementation that added 42 * 86400000 to
    // the start would ask for an hour past the end of the last cell.
    const range = gridRange('month', '2026-03-15', CHICAGO);
    const spanHours = (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000;
    expect(spanHours).toBe(42 * 24 - 1);
  });
});

describe('shiftAnchor', () => {
  it('steps a month by calendar month, not by 42 days', () => {
    expect(shiftAnchor('month', '2026-07-15', 1)).toBe('2026-08-01');
    expect(shiftAnchor('month', '2026-01-31', -1)).toBe('2025-12-01');
  });

  it('steps days and weeks without drifting across a DST boundary', () => {
    expect(shiftAnchor('day', SPRING_FORWARD, 1)).toBe('2026-03-09');
    expect(shiftAnchor('week', '2026-03-04', 1)).toBe('2026-03-11');
  });
});

describe('rangeContainsDay', () => {
  it('is true only when today is actually drawn', () => {
    const week = gridRange('week', '2026-07-22', CHICAGO);
    expect(rangeContainsDay(week, '2026-07-19')).toBe(true);
    expect(rangeContainsDay(week, '2026-07-26')).toBe(false);
  });
});

// --- degraded states --------------------------------------------------

describe('resolveBusy — a degraded calendar can never render as a free one', () => {
  const range = {
    from: '2026-07-19T05:00:00.000Z',
    to: '2026-07-20T05:00:00.000Z',
    timeZone: CHICAGO,
  };

  it('the contract itself refuses to carry busy on a degraded variant', () => {
    // Anchored at the contract, not at this client's beliefs: the parse
    // strips `busy` because the `consent_disabled` variant has no such
    // key. If someone widened the union to allow it, this fails.
    const sneaky = freeBusyFixture({
      ok: true,
      data: { status: 'consent_disabled', range, busy: [] },
    });
    expect('busy' in sneaky).toBe(false);
  });

  it('yields no blocks for consent_disabled', () => {
    const resolved = resolveBusy(degradedFixture('consent_disabled', range));
    expect(resolved.kind).toBe('unknown');
    expect(resolved).not.toHaveProperty('blocks');
    if (resolved.kind === 'unknown') expect(resolved.reason).toBe('consent_disabled');
  });

  it('yields no blocks for not_connected', () => {
    const resolved = resolveBusy(degradedFixture('not_connected', range));
    expect(resolved.kind).toBe('unknown');
    expect(resolved).not.toHaveProperty('blocks');
  });

  it('yields blocks only for ok', () => {
    const resolved = resolveBusy(
      okFixture(range, [{ start: '2026-07-19T14:00:00Z', end: '2026-07-19T15:00:00Z' }]),
    );
    expect(resolved.kind).toBe('known');
    if (resolved.kind === 'known') expect(resolved.blocks).toHaveLength(1);
  });

  it('an ok response with no busy time is knowledge, not a degraded state', () => {
    // The distinction the whole union exists for: a genuinely open day and
    // an unread calendar are different answers and must resolve to
    // different kinds.
    const resolved = resolveBusy(okFixture(range, []));
    expect(resolved.kind).toBe('known');
  });

  it('names a different remedy for each degraded reason', () => {
    const consent = unknownBusyMessage('consent_disabled');
    const disconnected = unknownBusyMessage('not_connected');
    expect(consent).not.toBe(disconnected);
    // Revoking a category does not revoke the OAuth grant (Foundation §8),
    // so the consent copy must not send the user through connect again.
    expect(consent.toLowerCase()).toContain('settings');
    expect(disconnected.toLowerCase()).toContain('connect');
    // Neither may claim anything about whether the user is free.
    for (const message of [consent, disconnected]) {
      expect(message.toLowerCase()).not.toContain('free');
      expect(message.toLowerCase()).not.toContain('open');
    }
  });
});

// --- merging ----------------------------------------------------------

describe('mergeBusy', () => {
  it('collapses overlapping windows so two calendars do not draw as twice as busy', () => {
    const merged = mergeBusy([
      { start: '2026-07-19T14:00:00Z', end: '2026-07-19T15:00:00Z' },
      { start: '2026-07-19T14:30:00Z', end: '2026-07-19T16:00:00Z' },
    ]);
    expect(merged).toEqual([
      { start: '2026-07-19T14:00:00.000Z', end: '2026-07-19T16:00:00.000Z' },
    ]);
  });

  it('keeps disjoint windows apart, including ones that merely touch', () => {
    const merged = mergeBusy([
      { start: '2026-07-19T14:00:00Z', end: '2026-07-19T15:00:00Z' },
      { start: '2026-07-19T16:00:00Z', end: '2026-07-19T17:00:00Z' },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('drops blocks it cannot place rather than guessing at them', () => {
    expect(
      mergeBusy([
        { start: 'not-a-time', end: '2026-07-19T15:00:00Z' },
        { start: '2026-07-19T16:00:00Z', end: '2026-07-19T15:00:00Z' },
      ]),
    ).toEqual([]);
  });
});

// --- layout and DST ---------------------------------------------------

describe('the calendar day is measured, never assumed to be 24 hours', () => {
  it('knows a spring-forward day is 23 hours and a fall-back day is 25', () => {
    expect(dayLengthMs(SPRING_FORWARD, CHICAGO) / 3_600_000).toBe(23);
    expect(dayLengthMs(FALL_BACK, CHICAGO) / 3_600_000).toBe(25);
    expect(dayLengthMs('2026-07-19', CHICAGO) / 3_600_000).toBe(24);
  });

  it('flags exactly the two transition days', () => {
    expect(isDstTransitionDay(SPRING_FORWARD, CHICAGO)).toBe(true);
    expect(isDstTransitionDay(FALL_BACK, CHICAGO)).toBe(true);
    expect(isDstTransitionDay('2026-07-19', CHICAGO)).toBe(false);
    // Sydney's transitions are on other dates entirely, which is the point
    // of computing this per zone rather than per date.
    expect(isDstTransitionDay(SPRING_FORWARD, SYDNEY)).toBe(false);
  });

  it('renders 23 hour rows on a spring-forward day, with 2 AM absent', () => {
    const rows = hourRows(SPRING_FORWARD, CHICAGO);
    expect(rows).toHaveLength(23);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('1 AM');
    // 2 AM did not happen. A `for (h = 0; h < 24; h++)` axis would print it.
    expect(labels).not.toContain('2 AM');
    expect(labels).toContain('3 AM');
  });

  it('draws the week’s shared axis from an ordinary day, not the short one', () => {
    // Found by measuring the rendered grid: with the axis taken from
    // dayKeys[0] the spring-forward week labelled one column correctly and
    // six incorrectly. The transition column is the one that carries a
    // visible explanation, so it is the right one to be approximate.
    const dstWeek = gridRange('week', SPRING_FORWARD, CHICAGO);
    expect(dstWeek.dayKeys[0]).toBe(SPRING_FORWARD);
    const reference = axisReferenceKey(dstWeek.dayKeys, CHICAGO);
    expect(reference).not.toBe(SPRING_FORWARD);
    expect(hourRows(reference, CHICAGO)).toHaveLength(24);

    // An ordinary week is unaffected — the first day is already fine.
    const plainWeek = gridRange('week', '2026-07-22', CHICAGO);
    expect(axisReferenceKey(plainWeek.dayKeys, CHICAGO)).toBe(plainWeek.dayKeys[0]);

    // A day view of the transition day itself has no ordinary day to fall
    // back to, and must label its own 23 hours rather than borrow 24.
    const dstDay = gridRange('day', SPRING_FORWARD, CHICAGO);
    expect(axisReferenceKey(dstDay.dayKeys, CHICAGO)).toBe(SPRING_FORWARD);
    expect(hourRows(axisReferenceKey(dstDay.dayKeys, CHICAGO), CHICAGO)).toHaveLength(23);
  });

  it('renders 25 hour rows on a fall-back day, with 1 AM twice', () => {
    const rows = hourRows(FALL_BACK, CHICAGO);
    expect(rows).toHaveLength(25);
    expect(rows.filter((r) => r.label === '1 AM')).toHaveLength(2);
  });

  it('places an afternoon block by elapsed time, not by wall-clock hour ÷ 24', () => {
    // 2 PM on the spring-forward day is 13 hours after midnight, not 14,
    // because the clock skipped an hour. Against a 23-hour day that is
    // 13/23; a naive implementation gives 14/24 or 13/24 and puts the
    // block roughly half an hour off, every year, in one direction.
    const start = zonedTimeToInstant(SPRING_FORWARD, 14, 0, CHICAGO);
    const end = zonedTimeToInstant(SPRING_FORWARD, 15, 0, CHICAGO);
    const [segment] = busySegmentsForDay(
      [{ start: start.toISOString(), end: end.toISOString() }],
      SPRING_FORWARD,
      CHICAGO,
    );
    expect(segment).toBeDefined();
    expect(segment!.top).toBeCloseTo(13 / 23, 10);
    expect(segment!.height).toBeCloseTo(1 / 23, 10);
    // The two wrong answers, named so a regression cannot pass by drifting
    // into one of them.
    expect(segment!.top).not.toBeCloseTo(14 / 24, 4);
    expect(segment!.top).not.toBeCloseTo(13 / 24, 4);
  });

  it('places the same wall-clock hour identically on an ordinary day', () => {
    const start = zonedTimeToInstant('2026-07-19', 9, 0, CHICAGO);
    const end = zonedTimeToInstant('2026-07-19', 10, 30, CHICAGO);
    const [segment] = busySegmentsForDay(
      [{ start: start.toISOString(), end: end.toISOString() }],
      '2026-07-19',
      CHICAGO,
    );
    expect(segment!.top).toBeCloseTo(9 / 24, 10);
    expect(segment!.height).toBeCloseTo(1.5 / 24, 10);
  });

  it('positions a block by the profile zone, not by UTC', () => {
    // 2026-07-19T23:00:00Z is 9 AM on the 20th in Sydney and 6 PM on the
    // 19th in Chicago. The same instant belongs to different cells, at
    // different heights — which is the entire reason the zone is a
    // parameter and never a default.
    const block = { start: '2026-07-19T23:00:00Z', end: '2026-07-20T00:00:00Z' };
    const [chicago] = busySegmentsForDay([block], '2026-07-19', CHICAGO);
    expect(chicago!.top).toBeCloseTo(18 / 24, 10);
    expect(busySegmentsForDay([block], '2026-07-20', CHICAGO)).toHaveLength(0);

    const [sydney] = busySegmentsForDay([block], '2026-07-20', SYDNEY);
    expect(sydney!.top).toBeCloseTo(9 / 24, 10);
    expect(busySegmentsForDay([block], '2026-07-19', SYDNEY)).toHaveLength(0);
  });
});

describe('busySegmentsForDay', () => {
  it('clips a block that spans midnight onto both days', () => {
    const start = zonedTimeToInstant('2026-07-19', 22, 0, CHICAGO).toISOString();
    const end = zonedTimeToInstant('2026-07-20', 6, 0, CHICAGO).toISOString();
    const first = busySegmentsForDay([{ start, end }], '2026-07-19', CHICAGO);
    const second = busySegmentsForDay([{ start, end }], '2026-07-20', CHICAGO);

    expect(first).toHaveLength(1);
    expect(first[0]!.top).toBeCloseTo(22 / 24, 10);
    expect(first[0]!.top + first[0]!.height).toBeCloseTo(1, 10);
    expect(first[0]!.continuesIntoNextDay).toBe(true);
    expect(first[0]!.continuesFromPreviousDay).toBe(false);

    // The second morning is genuinely busy. A grid that assigned the whole
    // block to the day it started on would draw it as open.
    expect(second).toHaveLength(1);
    expect(second[0]!.top).toBeCloseTo(0, 10);
    expect(second[0]!.height).toBeCloseTo(6 / 24, 10);
    expect(second[0]!.continuesFromPreviousDay).toBe(true);
  });

  it('excludes a block that only touches the boundary', () => {
    const midnight = dayStartInstant('2026-07-20', CHICAGO).toISOString();
    const earlier = dayStartInstant('2026-07-19', CHICAGO).toISOString();
    // [earlier, midnight) ends exactly where the 20th begins.
    expect(busySegmentsForDay([{ start: earlier, end: midnight }], '2026-07-20', CHICAGO)).toEqual(
      [],
    );
  });

  it('returns segments in chronological order, which is the reading order', () => {
    const at = (h: number) => zonedTimeToInstant('2026-07-19', h, 0, CHICAGO).toISOString();
    const segments = busySegmentsForDay(
      [
        { start: at(15), end: at(16) },
        { start: at(9), end: at(10) },
      ],
      '2026-07-19',
      CHICAGO,
    );
    expect(segments.map((s) => s.top)).toEqual(
      [...segments.map((s) => s.top)].sort((a, b) => a - b),
    );
  });
});

describe('kairosSegmentsForDay', () => {
  it('carries the theme, because these are the events we created', () => {
    const start = zonedTimeToInstant('2026-07-19', 9, 0, CHICAGO).toISOString();
    const end = zonedTimeToInstant('2026-07-19', 9, 15, CHICAGO).toISOString();
    const [segment] = kairosSegmentsForDay(
      [kairosEvent('e1', start, end, 'Stillness')],
      '2026-07-19',
      CHICAGO,
    );
    expect(segment!.theme).toBe('Stillness');
    expect(segment!.eventId).toBe('e1');
  });

  it('carries a null theme rather than inventing one for an ungenerated devotional', () => {
    const start = zonedTimeToInstant('2026-07-19', 9, 0, CHICAGO).toISOString();
    const end = zonedTimeToInstant('2026-07-19', 9, 15, CHICAGO).toISOString();
    const [segment] = kairosSegmentsForDay(
      [kairosEvent('e1', start, end, null)],
      '2026-07-19',
      CHICAGO,
    );
    expect(segment!.theme).toBeNull();
  });
});

describe('eventsInRange', () => {
  it('keeps only what the visible period touches', () => {
    const range = gridRange('week', '2026-07-22', CHICAGO);
    const inside = kairosEvent('in', '2026-07-21T14:00:00Z', '2026-07-21T14:15:00Z');
    const after = kairosEvent('out', '2026-08-01T14:00:00Z', '2026-08-01T14:15:00Z');
    expect(eventsInRange([inside, after], range).map((e) => e.id)).toEqual(['in']);
  });

  it('keeps an event that straddles the first boundary', () => {
    const range = gridRange('day', '2026-07-19', CHICAGO);
    const straddling = kairosEvent('s', '2026-07-19T04:30:00Z', '2026-07-19T05:30:00Z');
    expect(eventsInRange([straddling], range)).toHaveLength(1);
  });
});

// --- the month view's design constraint -------------------------------

describe('monthCells', () => {
  const range = gridRange('month', '2026-07-15', CHICAGO);
  const at = (day: string, h: number) => zonedTimeToInstant(day, h, 0, CHICAGO).toISOString();

  it('marks the focus month and the neighbouring days that fill the grid', () => {
    const cells = monthCells(range, '2026-07-15', { kind: 'known', blocks: [] }, []);
    expect(cells).toHaveLength(42);
    expect(cells[0]!.dateKey).toBe('2026-06-28');
    expect(cells[0]!.inFocusMonth).toBe(false);
    expect(cells.find((c) => c.dateKey === '2026-07-01')!.inFocusMonth).toBe(true);
  });

  it('labels the day number from the calendar day, never from a zone-converted instant', () => {
    // The `formatCalendarDate` bug in grid form: parsed as UTC midnight and
    // read in Chicago, '2026-07-01' is the evening of June 30th, so every
    // cell would be numbered one day early. Asserted in both zones because
    // the shift only appears in one of them.
    for (const zone of [CHICAGO, SYDNEY]) {
      const cells = monthCells(
        gridRange('month', '2026-07-15', zone),
        '2026-07-15',
        { kind: 'known', blocks: [] },
        [],
      );
      const first = cells.find((c) => c.dateKey === '2026-07-01');
      expect(first!.dayLabel).toBe('1');
      expect(cells.find((c) => c.dateKey === '2026-07-31')!.dayLabel).toBe('31');
    }
  });

  /**
   * The M4 decision, asserted rather than merely commented.
   *
   * `docs/14 §5.10` and Foundation §9 forbid scores and verdicts, and a
   * cell that varies with how busy the day was is a score whether or not
   * a number is printed. This test is the mechanical statement of that:
   * one meeting and nine meetings must be *indistinguishable* in the data
   * the view renders from.
   */
  it('draws a day with one commitment identically to a day with nine', () => {
    const oneMeeting = [{ start: at('2026-07-06', 9), end: at('2026-07-06', 10) }];
    const packedDay = Array.from({ length: 9 }, (_, i) => ({
      start: at('2026-07-07', 8 + i),
      end: at('2026-07-07', 9 + i),
    }));

    const cells = monthCells(
      range,
      '2026-07-15',
      { kind: 'known', blocks: [...oneMeeting, ...packedDay] },
      [],
    );
    const light = cells.find((c) => c.dateKey === '2026-07-06')!;
    const heavy = cells.find((c) => c.dateKey === '2026-07-07')!;

    expect(light.commitment).toBe('committed');
    expect(heavy.commitment).toBe('committed');
    // Everything the view can see, minus the cell's own identity. If a
    // density number, ratio or bucket is ever added, these stop matching.
    const renderable = ({ dateKey, dayLabel, ...rest }: typeof light) => {
      void dateKey;
      void dayLabel;
      return rest;
    };
    expect(renderable(light)).toEqual(renderable(heavy));
  });

  it('exposes no numeric density on a cell at all', () => {
    const cells = monthCells(
      range,
      '2026-07-15',
      { kind: 'known', blocks: [{ start: at('2026-07-06', 9), end: at('2026-07-06', 17) }] },
      [],
    );
    const cell = cells.find((c) => c.dateKey === '2026-07-06')!;
    // A ramp, a percentage or a count would all have to arrive as a number
    // on this object. There is nowhere else for the view to read one from.
    const numericFields = Object.entries(cell).filter(([, v]) => typeof v === 'number');
    expect(numericFields).toEqual([]);
  });

  it('distinguishes a quiet day from a day it could not read', () => {
    const known = monthCells(range, '2026-07-15', { kind: 'known', blocks: [] }, []);
    const unknown = monthCells(
      range,
      '2026-07-15',
      { kind: 'unknown', reason: 'consent_disabled' },
      [],
    );
    expect(known.every((c) => c.commitment === 'quiet')).toBe(true);
    // The whole point: a revoked calendar must not paint as 42 open days.
    expect(unknown.every((c) => c.commitment === 'unknown')).toBe(true);
    expect(unknown.some((c) => c.commitment === 'quiet')).toBe(false);
  });

  it('still shows Wellspring slots when free/busy is unreadable — those are ours', () => {
    const event = kairosEvent('e1', at('2026-07-06', 9), at('2026-07-06', 9));
    const withDuration = { ...event, gapEndAt: at('2026-07-06', 10) };
    const cells = monthCells(range, '2026-07-15', { kind: 'unknown', reason: 'not_connected' }, [
      withDuration,
    ]);
    const cell = cells.find((c) => c.dateKey === '2026-07-06')!;
    expect(cell.commitment).toBe('unknown');
    expect(cell.kairos).toHaveLength(1);
    expect(cell.kairos[0]!.theme).toBe('Rest');
  });
});

// --- labels -----------------------------------------------------------

describe('labels are formatted from the calendar day, not from an instant', () => {
  it('names the month the grid is focused on, in either zone', () => {
    for (const zone of [CHICAGO, SYDNEY]) {
      expect(monthLabel('2026-07-01')).toBe('July 2026');
      expect(periodLabel('month', gridRange('month', '2026-07-01', zone), '2026-07-01')).toBe(
        'July 2026',
      );
      // The 1st is the trap: UTC-midnight-in-Chicago is June 30th.
      expect(periodLabel('day', gridRange('day', '2026-07-01', zone), '2026-07-01')).toBe(
        'Wednesday, July 1',
      );
    }
  });

  it('names a week by its first and last cells', () => {
    const range = gridRange('week', '2026-07-22', CHICAGO);
    expect(periodLabel('week', range, '2026-07-22')).toBe('Jul 19 – Jul 25');
  });

  it('names a day that crosses a year boundary correctly', () => {
    expect(periodLabel('day', gridRange('day', '2026-01-01', SYDNEY), '2026-01-01')).toBe(
      'Thursday, January 1',
    );
  });
});

// --- out-of-order responses -------------------------------------------

describe('answersRange', () => {
  const range = gridRange('day', '2026-07-19', CHICAGO);

  it('accepts a response for the range on screen', () => {
    const data = okFixture({ from: range.from, to: range.to, timeZone: CHICAGO }, []);
    expect(answersRange(data, range)).toBe(true);
  });

  it('rejects a late response for a range the user has moved off', () => {
    const stale = gridRange('day', '2026-07-18', CHICAGO);
    const data = okFixture({ from: stale.from, to: stale.to, timeZone: CHICAGO }, []);
    expect(answersRange(data, range)).toBe(false);
  });

  it('matches on the instant, not the string, so a formatting difference is not a miss', () => {
    const data = okFixture(
      { from: '2026-07-19T05:00:00Z', to: '2026-07-20T05:00:00+00:00', timeZone: CHICAGO },
      [],
    );
    expect(answersRange(data, range)).toBe(true);
  });

  it('checks the degraded variants too — they carry a range for this reason', () => {
    const data = degradedFixture('not_connected', {
      from: range.from,
      to: range.to,
      timeZone: CHICAGO,
    });
    expect(answersRange(data, range)).toBe(true);
  });
});

// --- day-key arithmetic -----------------------------------------------

describe('addDays', () => {
  it('crosses a DST boundary without losing or repeating a day', () => {
    expect(addDays('2026-03-07', 1)).toBe(SPRING_FORWARD);
    expect(addDays(SPRING_FORWARD, 1)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe(FALL_BACK);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
