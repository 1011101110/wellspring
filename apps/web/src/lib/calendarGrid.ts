/**
 * The calendar view's logic — every decision that can be made without a
 * DOM (M2–M5, epic #255).
 *
 * The components under `components/dashboard/calendar/` render what this
 * module computes and decide nothing themselves. That split is deliberate:
 * the hard parts here are the range arithmetic, the calendar-day/instant
 * boundary, and the degraded-state handling, and all three are testable
 * only if they are not tangled into JSX.
 *
 * ## The one rule this module exists to enforce
 *
 * **A degraded free/busy response can never produce a list of busy
 * blocks.** `resolveBusy` is a total function over the discriminated
 * union, and its non-`ok` result carries no array at all — mirroring the
 * contract, where `busy` exists only on the `ok` variant. A view that
 * wants to draw blocks has to go through a `kind: 'known'` value to get
 * them, so "the user revoked consent" cannot be rendered as "the user is
 * completely free". The contract's module doc calls that the failure of
 * #253; this is the client half of not repeating it.
 */
import {
  FREEBUSY_MAX_RANGE_DAYS,
  type FreeBusyBlockDto,
  type FreeBusyData,
  type UpcomingCalendarEvent,
} from '@kairos/shared-contracts';
import { addDays, dayLengthMs, dayStartInstant, weekdayOfDateKey, type DateKey } from './datetime';

const MS_PER_HOUR = 3_600_000;

export type CalendarViewMode = 'day' | 'week' | 'month';

export const VIEW_MODES: readonly CalendarViewMode[] = ['day', 'week', 'month'] as const;

export const VIEW_LABELS: Readonly<Record<CalendarViewMode, string>> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

// --- range ------------------------------------------------------------

export interface GridRange {
  mode: CalendarViewMode;
  /** The cells, in reading order. `dayKeys[0]` is the top-left cell. */
  dayKeys: readonly DateKey[];
  /** `?from=` — the instant the first cell begins, in the profile zone. */
  from: string;
  /** `?to=` — the instant *after* the last cell ends. Exclusive, like the cells. */
  to: string;
  /** The zone the boundaries above were computed in. Carried so a stale response can be spotted. */
  zone: string;
}

/**
 * Weeks start on Sunday.
 *
 * Not an aesthetic choice: `activeDays` uses `0=Sunday..6=Saturday`
 * (migration 1720000000000) and `weekdayInZone` was written to match it so
 * the two could be compared without an off-by-one. A grid that started on
 * Monday would introduce exactly the offset that convention exists to
 * avoid, in the one place the user can see both at once.
 */
const WEEK_STARTS_ON = 0;

function startOfWeek(dateKey: DateKey): DateKey {
  const offset = (weekdayOfDateKey(dateKey) - WEEK_STARTS_ON + 7) % 7;
  return addDays(dateKey, -offset);
}

/**
 * The six-row month grid always has 42 cells.
 *
 * Fixed rather than trimmed to the month's actual row count, because a
 * grid that is five rows in one month and six in the next changes height
 * as the user pages through it, which moves everything below it on the
 * dashboard. 42 is also the number the 45-day server cap was sized
 * against (see `FREEBUSY_MAX_RANGE_DAYS`).
 */
const MONTH_GRID_CELLS = 42;

/**
 * The cells a view covers, and the instants that bound them.
 *
 * `anchorKey` is a calendar day, never an instant — the caller converts
 * `now` to a day key in the profile zone once, at the top, and everything
 * below reasons in cells. Handing this function a `Date` is how the
 * browser's zone gets back in.
 */
export function gridRange(mode: CalendarViewMode, anchorKey: DateKey, zone: string): GridRange {
  const firstKey =
    mode === 'day'
      ? anchorKey
      : mode === 'week'
        ? startOfWeek(anchorKey)
        : startOfWeek(`${anchorKey.slice(0, 7)}-01`);

  const count = mode === 'day' ? 1 : mode === 'week' ? 7 : MONTH_GRID_CELLS;

  const dayKeys: DateKey[] = [];
  for (let i = 0; i < count; i += 1) dayKeys.push(addDays(firstKey, i));

  /*
   * The server answers a range wider than 45 days with a 400, and it is
   * right to (the cap is our own quota protection, not a mirror of a
   * Google limit — see the correction on #255). No view here can exceed
   * it: the widest is 42 cells. This throws rather than clamps because a
   * clamp would paint a silently-truncated month, and there is no input
   * that can reach it — it guards a future fourth view, not a user.
   */
  if (dayKeys.length > FREEBUSY_MAX_RANGE_DAYS) {
    throw new Error(
      `Calendar view would request ${dayKeys.length} days, above the ${FREEBUSY_MAX_RANGE_DAYS}-day server limit.`,
    );
  }

  const lastKey = dayKeys[dayKeys.length - 1] ?? firstKey;
  return {
    mode,
    dayKeys,
    from: dayStartInstant(firstKey, zone).toISOString(),
    to: dayStartInstant(addDays(lastKey, 1), zone).toISOString(),
    zone,
  };
}

/** Moves the view one period. Month steps by month, not by 42 days, or the grid would drift. */
export function shiftAnchor(mode: CalendarViewMode, anchorKey: DateKey, delta: number): DateKey {
  if (mode === 'day') return addDays(anchorKey, delta);
  if (mode === 'week') return addDays(anchorKey, delta * 7);
  const [y, m] = anchorKey.slice(0, 7).split('-');
  const year = Number.parseInt(y ?? '', 10);
  const month = Number.parseInt(m ?? '', 10);
  // Day 1 always exists in every month, so this cannot land on the 31st of
  // a 30-day month and roll into the next one.
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return shifted.toISOString().slice(0, 10);
}

// --- free/busy state --------------------------------------------------

/**
 * What we know about the user's commitments over the range.
 *
 * The `unknown` variant deliberately carries no `blocks` key — not an
 * empty one. See the module header.
 */
export type BusyKnowledge =
  | { kind: 'known'; blocks: readonly FreeBusyBlockDto[] }
  | { kind: 'unknown'; reason: 'consent_disabled' | 'not_connected' };

/**
 * The contract's union, narrowed to what the grid can draw.
 *
 * Written as an exhaustive switch with a `never` fallthrough so that a
 * fourth `status` added to the contract fails the build here rather than
 * defaulting into one of the existing branches. A silent default is how a
 * new degraded state would end up rendering as a free calendar.
 */
export function resolveBusy(data: FreeBusyData): BusyKnowledge {
  switch (data.status) {
    case 'ok':
      return { kind: 'known', blocks: mergeBusy(data.busy) };
    case 'consent_disabled':
      return { kind: 'unknown', reason: 'consent_disabled' };
    case 'not_connected':
      return { kind: 'unknown', reason: 'not_connected' };
    default: {
      const exhaustive: never = data;
      void exhaustive;
      throw new Error('Wellspring sent a calendar state this app does not understand.');
    }
  }
}

/**
 * The sentence the whole feature turns on.
 *
 * A grid of unlabelled blocks reads as broken, or as data that failed to
 * load. It is neither: `freebusy.query` returns start and end and nothing
 * else, because the granted scopes are `calendar.freebusy` +
 * `calendar.events` and deliberately not `calendar.readonly`. There is no
 * title being withheld here — there was never a title to withhold.
 *
 * Stated as a capability rather than an apology (#255: "the constraint is
 * the feature; show it as one"), and placed above the grid rather than
 * behind a tooltip, because the person who needs it most is the one seeing
 * the blank blocks for the first time.
 *
 * Lives here beside `unknownBusyMessage` rather than on the card, so that
 * the states preview can render it without importing the card — and
 * therefore without pulling in the API client, which reaches Firebase
 * config and throws on a machine with no key. That is the constraint
 * `preview/main.tsx` documents; copy in a component module is how a
 * fixture-only page acquires a network dependency by accident.
 */
export const PRIVACY_NOTE = 'Wellspring sees when you\u2019re busy, never what you\u2019re doing.';

/**
 * Copy for a state where we cannot see the calendar.
 *
 * Neither sentence says anything about whether the user is free, because
 * we do not know — that is the entire point of the state. Each names the
 * remedy that actually applies: the consent case needs a toggle and the
 * disconnected case needs the OAuth flow, and collapsing them would send a
 * user who revoked consent to a reconnect button that changes nothing
 * (Foundation §8: revoking a category does not revoke the OAuth grant).
 */
export function unknownBusyMessage(reason: 'consent_disabled' | 'not_connected'): string {
  return reason === 'consent_disabled'
    ? 'Calendar reading is turned off, so Wellspring cannot show your commitments here. Your Google connection is untouched — turning it back on is one switch in settings.'
    : 'Connect your Google Calendar and Wellspring can show you where your commitments sit.';
}

/**
 * Overlapping windows collapsed into disjoint ones.
 *
 * `freebusy.query` reports per-calendar, so a user with a work and a
 * personal calendar gets two windows for one double-booked hour. Drawn
 * literally that is two stacked blocks — which reads as "busier" than one,
 * and is the closest this view could accidentally get to rendering a
 * quantity. Merging makes the drawing a statement about *time*, which is
 * all we know, rather than about calendar count, which is not information
 * the user asked for.
 *
 * Blocks with unparseable or inverted times are dropped rather than
 * clamped: a block we cannot place is not a block we should guess at.
 */
export function mergeBusy(blocks: readonly FreeBusyBlockDto[]): readonly FreeBusyBlockDto[] {
  const spans = blocks
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end), raw: b }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged.map((m) => ({
    start: new Date(m.start).toISOString(),
    end: new Date(m.end).toISOString(),
  }));
}

// --- layout -----------------------------------------------------------

/**
 * A block as positioned inside one day column, as fractions of that day.
 *
 * Fractions rather than pixels or hours, because the denominator is the
 * day's *measured* length. On a 23-hour day an event at 3pm is further
 * down the column than the same wall-clock time on a 24-hour day, and
 * expressing positions as a share of the real elapsed day is what makes
 * that fall out automatically instead of needing a DST special case.
 */
export interface DaySegment {
  /** Which cell this piece belongs to. */
  dateKey: DateKey;
  /** 0 = the day's midnight, 1 = the next day's midnight. */
  top: number;
  /** Never zero — a sub-minute block still gets a perceivable height from the CSS floor. */
  height: number;
  /** The clipped instants, so a label can render the real times rather than the fractions. */
  startIso: string;
  endIso: string;
  /** True when the block began before this cell — the piece is a continuation. */
  continuesFromPreviousDay: boolean;
  /** True when the block runs past this cell's midnight. */
  continuesIntoNextDay: boolean;
}

interface Span {
  start: number;
  end: number;
}

function clipToDay(span: Span, dateKey: DateKey, zone: string): DaySegment | null {
  const dayStart = dayStartInstant(dateKey, zone).getTime();
  const length = dayLengthMs(dateKey, zone);
  if (!Number.isFinite(length) || length <= 0) return null;
  const dayEnd = dayStart + length;

  const start = Math.max(span.start, dayStart);
  const end = Math.min(span.end, dayEnd);
  if (end <= start) return null;

  return {
    dateKey,
    top: (start - dayStart) / length,
    height: (end - start) / length,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    continuesFromPreviousDay: span.start < dayStart,
    continuesIntoNextDay: span.end > dayEnd,
  };
}

/**
 * The pieces of `blocks` that fall inside one cell.
 *
 * A block spanning midnight is *clipped*, not assigned to whichever day it
 * started in. An overnight flight is genuinely busy time on both days, and
 * a grid that showed it only on the first would draw the second morning as
 * open.
 */
export function busySegmentsForDay(
  blocks: readonly FreeBusyBlockDto[],
  dateKey: DateKey,
  zone: string,
): readonly DaySegment[] {
  const segments: DaySegment[] = [];
  for (const block of blocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const segment = clipToDay({ start, end }, dateKey, zone);
    if (segment) segments.push(segment);
  }
  return segments.sort((a, b) => a.top - b.top);
}

/** A Wellspring booking, positioned like a busy block but carrying the theme we are entitled to show. */
export interface KairosSegment extends DaySegment {
  eventId: string;
  /** `null` when the devotional has not been generated yet — normal for anything more than a day out. */
  theme: string | null;
}

export function kairosSegmentsForDay(
  events: readonly UpcomingCalendarEvent[],
  dateKey: DateKey,
  zone: string,
): readonly KairosSegment[] {
  const segments: KairosSegment[] = [];
  for (const event of events) {
    const start = Date.parse(event.gapStartAt);
    const end = Date.parse(event.gapEndAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const segment = clipToDay({ start, end }, dateKey, zone);
    if (segment) {
      segments.push({ ...segment, eventId: event.id, theme: event.devotional?.theme ?? null });
    }
  }
  return segments.sort((a, b) => a.top - b.top);
}

/** Only the events that touch the visible range — the upcoming endpoint is not range-scoped. */
export function eventsInRange(
  events: readonly UpcomingCalendarEvent[],
  range: GridRange,
): readonly UpcomingCalendarEvent[] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return events.filter((event) => {
    const start = Date.parse(event.gapStartAt);
    const end = Date.parse(event.gapEndAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return end > from && start < to;
  });
}

// --- the time axis ----------------------------------------------------

export interface HourRow {
  /** `'9 AM'`, in the profile zone. */
  label: string;
  /** Where this row's boundary sits — see `DaySegment.top`. */
  top: number;
  /** The instant this row begins. */
  iso: string;
}

/**
 * The hour rows of a day column.
 *
 * Built by stepping one hour of *elapsed time* from midnight until the
 * next midnight, then asking the zone what each step's wall clock says.
 * That produces 23 rows on a spring-forward day (2 AM is simply absent,
 * because it did not happen) and 25 on a fall-back day (1 AM appears
 * twice, because it did). Both are correct, and neither needs a branch.
 *
 * The alternative — looping `for (let h = 0; h < 24; h++)` — is the shape
 * that misplaces every block below the transition twice a year.
 */
export function hourRows(dateKey: DateKey, zone: string): readonly HourRow[] {
  const dayStart = dayStartInstant(dateKey, zone).getTime();
  const length = dayLengthMs(dateKey, zone);
  if (!Number.isFinite(length) || length <= 0) return [];

  const rows: HourRow[] = [];
  for (let elapsed = 0; elapsed < length; elapsed += MS_PER_HOUR) {
    const instant = new Date(dayStart + elapsed);
    rows.push({
      label: new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric' }).format(instant),
      top: elapsed / length,
      iso: instant.toISOString(),
    });
  }
  return rows;
}

/**
 * Which day the week view's shared hour axis should be drawn from.
 *
 * A week containing a DST transition has columns of genuinely different
 * heights — 23 hours in one, 24 in the other six — and one axis cannot
 * label both correctly. Something has to be approximate, so the choice is
 * *which* column the labels are right for.
 *
 * Drawing from `dayKeys[0]` (the obvious choice) is the worst one: on a
 * spring-forward week that is the 23-hour Sunday, so the axis is correct
 * for one column and roughly 4% out for the other six. Preferring the
 * first ordinary day inverts that — right for six, out for one — and the
 * odd column is the one carrying a visible "clocks change today" note, so
 * the discrepancy lands where it is already explained.
 *
 * This was found by measuring rendered geometry in the states preview, not
 * by a unit test: every block was individually in the right place, which
 * is what the tests assert, and the axis beside them still disagreed.
 */
export function axisReferenceKey(dayKeys: readonly DateKey[], zone: string): DateKey {
  return dayKeys.find((key) => !isDstTransitionDay(key, zone)) ?? dayKeys[0] ?? '';
}

/** True on the two days a year the grid would be wrong if it assumed 24 hours. */
export function isDstTransitionDay(dateKey: DateKey, zone: string): boolean {
  return dayLengthMs(dateKey, zone) !== 24 * MS_PER_HOUR;
}

// --- the month cell ---------------------------------------------------

/**
 * What a month cell is allowed to say about a day.
 *
 * ## The decision, and why it is this one (#255's M4 question)
 *
 * The obvious month view is a heatmap: shade each cell by the share of the
 * day that is busy. It is also out of bounds. `docs/14 §5.10` and
 * Foundation §9 forbid streaks, scores and verdicts, and a colour ramp
 * across 42 cells is a score — it is legible precisely *because* it is
 * comparable, and what it invites the user to compare is how full their
 * days were. "You were busy 22 of 30 days" is not a sentence this product
 * gets to write, and a ramp writes it in a form that needs no words.
 *
 * #255 permits density to inform layout without being *rendered* as a
 * quantity. So this type carries a boolean, not a number:
 *
 *  - `hasCommitments` — whether any busy time touches the day at all.
 *    Binary, unranked, and identical for a day with one meeting and a day
 *    with nine. That is the quiet option: it is enough for the grid to
 *    read as a calendar rather than a list of Wellspring slots, and it cannot
 *    be arranged into a ranking of the user's month.
 *  - `kairos` — the slots, which are labelled, because we created them.
 *
 * There is deliberately no busy count, no busy-minutes total, no
 * proportion, and no aggregate over the month anywhere in this module or
 * the components that read it. The fraction *is* computable from the data
 * this file already holds; not computing it is the point.
 *
 * `unknown` is a third state rather than `hasCommitments: false`, for the
 * same reason the contract has no `busy: []` — a day we could not read
 * must not draw the same as a day we read and found open.
 */
export interface MonthCell {
  dateKey: DateKey;
  /** The day number, `'1'`–`'31'`. */
  dayLabel: string;
  /** False for the leading/trailing cells that belong to the neighbouring month. */
  inFocusMonth: boolean;
  /** `'quiet' | 'committed'` when we can see the calendar; `'unknown'` when we cannot. */
  commitment: 'quiet' | 'committed' | 'unknown';
  kairos: readonly KairosSegment[];
}

export function monthCells(
  range: GridRange,
  focusMonth: string,
  busy: BusyKnowledge,
  events: readonly UpcomingCalendarEvent[],
): readonly MonthCell[] {
  return range.dayKeys.map((dateKey) => {
    const kairos = kairosSegmentsForDay(events, dateKey, range.zone);
    const commitment: MonthCell['commitment'] =
      busy.kind === 'unknown'
        ? 'unknown'
        : busySegmentsForDay(busy.blocks, dateKey, range.zone).length > 0
          ? 'committed'
          : 'quiet';
    return {
      dateKey,
      dayLabel: String(Number.parseInt(dateKey.slice(8, 10), 10)),
      inFocusMonth: dateKey.slice(0, 7) === focusMonth.slice(0, 7),
      commitment,
      kairos,
    };
  });
}

// --- response freshness ----------------------------------------------

/**
 * Whether a response answers the range currently on screen.
 *
 * The toggle fires overlapping requests and they can land out of order —
 * which the contract anticipated by echoing `range` on every variant. Late
 * responses are matched on those fields rather than assumed to be the
 * newest, because a stale week painted into a month grid is wrong in a way
 * that looks entirely plausible.
 */
export function answersRange(data: FreeBusyData, range: GridRange): boolean {
  return (
    Date.parse(data.range.from) === Date.parse(range.from) &&
    Date.parse(data.range.to) === Date.parse(range.to)
  );
}

// --- labels -----------------------------------------------------------

/**
 * Formats a calendar day, never an instant.
 *
 * Every label below goes through UTC noon rather than the day's real
 * midnight in the profile zone. That is the `formatCalendarDate`
 * discipline: a cell's identity is `'2026-07-19'` and rendering it must
 * not be able to shift it. Noon is used rather than midnight so that even
 * a ±14h zone slip could not cross a date boundary.
 */
function formatDateKey(dateKey: DateKey, options: Intl.DateTimeFormatOptions): string {
  const instant = new Date(`${dateKey.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(instant.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(instant);
}

/** `'July 2026'` for the month a grid is focused on. */
export function monthLabel(anchorKey: DateKey): string {
  return formatDateKey(`${anchorKey.slice(0, 7)}-01`, { month: 'long', year: 'numeric' });
}

/** The period currently drawn — `'Sunday, July 19'`, `'Jul 19 – Jul 25'`, `'July 2026'`. */
export function periodLabel(mode: CalendarViewMode, range: GridRange, anchorKey: DateKey): string {
  if (mode === 'month') return monthLabel(anchorKey);
  const first = range.dayKeys[0] ?? anchorKey;
  if (mode === 'day') {
    return formatDateKey(first, { weekday: 'long', month: 'long', day: 'numeric' });
  }
  const last = range.dayKeys[range.dayKeys.length - 1] ?? first;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${formatDateKey(first, opts)} – ${formatDateKey(last, opts)}`;
}

/** True when the given view already contains today — used to hide a "Today" button that would do nothing. */
export function rangeContainsDay(range: GridRange, dateKey: DateKey): boolean {
  return range.dayKeys.includes(dateKey);
}

// --- the visible time window ------------------------------------------

/**
 * Which slice of the day the time grid actually shows (N6, issue #265).
 *
 * ## The problem this solves, and the one it caused
 *
 * The grid spanned midnight to midnight in a fixed 34rem. An 8am–6pm
 * workday is 42% of that, so **58% of the tallest element on the
 * dashboard was empty night** — in a product whose entire premise is
 * finding the gap in a workday.
 *
 * That compression was not only wasteful, it was the root cause of the
 * clipped labels (#264/A3): a 20-minute meeting got 12px against a 42px
 * `scrollHeight`, so `overflow: hidden` sliced the second line
 * horizontally through the middle of the letterforms. An unlabelled block
 * reads as intentional; a block with text cut in half reads as a
 * rendering bug. Showing the same 34rem over ten hours instead of
 * twenty-four gives that block ≈34px — enough for its label — which is
 * why one change fixes legibility, density and calm together.
 *
 * ## Why this is a zoom and not new arithmetic
 *
 * Every `DaySegment.top`/`height` is already a fraction of its own day's
 * true length, which is what makes the grid correct on the two DST days a
 * year (23 rows in one column, 25 in another, no branches). Recomputing
 * those fractions against a window would mean rewriting exactly the
 * arithmetic that took the most care to get right.
 *
 * So nothing about the segments changes. The column is rendered TALLER
 * than its container by `zoom`, and scrolled to `offset`. The percentages
 * inside it stay untouched and land where they always did — the viewport
 * just shows a slice. `hourRows`, `busySegmentsForDay`,
 * `kairosSegmentsForDay` and `axisReferenceKey` are all unmodified by
 * this feature.
 */
export interface TimeWindow {
  /** Fraction of the day the window begins at — `9/24` for a 9am start. */
  offset: number;
  /** How much taller the column is than the viewport. `1` shows the whole day. */
  zoom: number;
}

export const FULL_DAY_WINDOW: TimeWindow = { offset: 0, zoom: 1 };

/**
 * A window that shows `[startHour, endHour)` with a little air either side.
 *
 * The padding is deliberate: a busy block that starts exactly at the
 * user's window start would otherwise sit flush against the top edge and
 * look clipped, and an early meeting just outside the window would vanish
 * without trace. An hour of margin means the window reads as "your day,
 * mostly" rather than as a hard crop that might be hiding something.
 *
 * Falls back to the full day for a window that is empty, inverted, or
 * wide enough that zooming would gain nothing — refusing to zoom is
 * always safe, whereas a bad zoom hides real commitments.
 */
export function workdayWindow(startHour: number, endHour: number): TimeWindow {
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return FULL_DAY_WINDOW;

  const from = Math.max(0, Math.floor(startHour) - 1);
  const to = Math.min(24, Math.ceil(endHour) + 1);
  const hours = to - from;

  // Below ~6 hours the zoom gets extreme enough that scrolling to
  // anything outside the window becomes a chore; above ~18 there is
  // almost nothing to gain. Both ends fall back rather than guess.
  if (hours < 6 || hours >= 18) return FULL_DAY_WINDOW;

  return { offset: from / 24, zoom: 24 / hours };
}
