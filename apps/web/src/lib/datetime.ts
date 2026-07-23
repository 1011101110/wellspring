/**
 * Rendering instants in a named time zone.
 *
 * ## Why every function here takes an explicit zone
 *
 * A bare `new Date(iso).toLocaleString()` formats in whatever zone the
 * browser happens to be in, silently. That is the #205 class of bug: the
 * scheduling backend reasons in the user's stored zone, and a client that
 * reasons in the device's zone agrees with it right up until the user
 * travels — at which point the dashboard confidently displays a time that
 * is not when the devotional will happen. There is no error, no warning,
 * and no way for the user to tell.
 *
 * So the zone is a required parameter, never a default. Formatting is a
 * function of (instant, zone) and both are supplied by the caller.
 *
 * ## The zone we can actually get, and the one we cannot (contract gap)
 *
 * #240 asks for times "in the user's timezone ... web should use the
 * profile timezone, not blindly the browser's". **No endpoint returns the
 * profile timezone.** `users.timezone` is push-only by construction
 * (#187): `PUT /v1/preferences` writes it and `GET /v1/preferences` does
 * not echo it back — see the `Timezone is push-only` note in
 * `lib/preferences.ts`. `GET /v1/connections` carries provider, status,
 * connectedAt and scopes, and no zone either.
 *
 * Rather than pretend, this module does two things:
 *
 *  1. `profileTimezone` is an *optional* parameter threaded from the top
 *     of the dashboard. It is `undefined` today, and the day the API
 *     starts returning the stored zone this becomes a one-line change at
 *     the call site instead of a rewrite of every card.
 *  2. Because we cannot prove which zone is right, we **label the zone we
 *     used** on every rendered time (`9:00 AM CDT`). A user who has
 *     travelled can see the mismatch themselves. An unlabeled time is a
 *     claim the user cannot check; a labeled one is a claim they can.
 *
 * `resolveZone` also carries the mismatch hint for when the profile zone
 * does arrive — the comparison is real, it simply has nothing to compare
 * against yet.
 */

/** The browser's own IANA zone. Never used implicitly — callers pass it in. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A zone string that `Intl` will actually accept.
 *
 * An unknown or malformed identifier makes every `DateTimeFormat` call
 * throw, which would take out the whole upcoming card over a bad column
 * value. Falling back to UTC renders a wrong-but-labeled time instead of
 * nothing at all — and the label is what tells the user it is wrong.
 */
export function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

export interface ResolvedZone {
  /** The zone every time on the dashboard is rendered in. */
  zone: string;
  /**
   * True when the profile zone and the browser zone disagree — i.e. the
   * user is somewhere other than where Wellspring schedules them. Always
   * `false` while `profileTimezone` is undefined, because two things are
   * needed to disagree.
   */
  travelling: boolean;
  /** The browser zone, retained so the hint can name both. */
  browserZone: string;
}

/**
 * Picks the zone to render in: the profile zone when we have a *real* one
 * (it is the zone the backend schedules in, so it is the zone the times
 * *mean*), otherwise the browser's.
 *
 * ## Why a bare `UTC` profile zone is treated as "not known" (#301)
 *
 * `users.timezone` defaults to `'UTC'` and is only populated when a real
 * one is learned — the web client pushes the browser's `Intl` zone on every
 * save, and connect adopts the calendar's zone (`connect.ts`). A user who
 * has not triggered either path (connected but never saved, or whose
 * connect never completed — see #298) still reads back `'UTC'`, and that is
 * a *default*, not a fact about where they are. Rendering a New York user's
 * calendar in UTC because the server never learned their zone is the whole
 * of #301: the banner even said "UTC is where Wellspring schedules you"
 * while the browser sat in America/New_York.
 *
 * So a profile zone of exactly `'UTC'` falls through to the browser's zone,
 * which is the better available answer and still carries a checkable label
 * (`9:00 AM EDT`) on every rendered time. A user who is *genuinely* in UTC
 * has a browser zone of UTC too, so the result is unchanged for them; only
 * the "server never learned it" case is repaired. A real, non-UTC profile
 * zone still wins and still surfaces the travel mismatch, exactly as before.
 */
export function resolveZone(profileTimezone: string | undefined, browserZone: string): ResolvedZone {
  const browser = safeZone(browserZone);
  const profile = profileTimezone ? safeZone(profileTimezone) : undefined;
  // `undefined` (field absent) and `'UTC'` (the unpopulated default) are the
  // same signal here: we do not actually know the user's zone, so render in
  // the browser's and claim no travel — there is nothing trustworthy to
  // disagree with.
  if (!profile || profile === 'UTC') {
    return { zone: browser, travelling: false, browserZone: browser };
  }
  return { zone: profile, travelling: profile !== browser, browserZone: browser };
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(iso: string, zone: string, options: Intl.DateTimeFormatOptions): string {
  const date = parse(iso);
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: safeZone(zone) }).format(date);
  } catch {
    return '';
  }
}

/** `'9:00 AM'`. */
export function formatTime(iso: string, zone: string): string {
  return format(iso, zone, { hour: 'numeric', minute: '2-digit' });
}

/** `'CDT'` — the short zone name, which is the checkable half of a rendered time. */
export function formatZoneAbbreviation(iso: string, zone: string): string {
  const parts = format(iso, zone, { hour: 'numeric', timeZoneName: 'short' }).split(' ');
  return parts[parts.length - 1] ?? '';
}

/** `'9:00 AM CDT'` — the form actually rendered, because the label is not optional. */
export function formatTimeWithZone(iso: string, zone: string): string {
  const time = formatTime(iso, zone);
  if (!time) return '';
  const abbreviation = formatZoneAbbreviation(iso, zone);
  return abbreviation ? `${time} ${abbreviation}` : time;
}

/** `'Monday, July 21'`. */
export function formatDay(iso: string, zone: string): string {
  return format(iso, zone, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** `'Monday'`. */
export function formatWeekday(iso: string, zone: string): string {
  return format(iso, zone, { weekday: 'long' });
}

/**
 * `'2026-07-22'` -> `'Wednesday, July 22'`.
 *
 * **A date-only value must never be zone-converted**, and this function
 * exists because doing so is a bug that looks like correctness.
 * `devotionals.date` is a Postgres `date` — a calendar day with no time
 * and no zone, meaning "the day this devotional is for". Passing it to
 * `formatDay` sends it through `new Date('2026-07-22')`, which JavaScript
 * parses as *UTC midnight*; rendered in Chicago that instant is 7pm on
 * the 21st, so every row in the archive displays the day before the one it
 * belongs to.
 *
 * This was caught by looking at the rendered archive, not by a type error
 * — both values are `string`, which is exactly why the two cases need
 * separately named functions rather than a shared one with a zone
 * argument. `gapStartAt` is an instant and must be converted;
 * `date` is a calendar day and must not be.
 *
 * Formatted in UTC deliberately: the value was parsed as UTC midnight, so
 * reading it back in UTC returns the same calendar day the server sent.
 */
export function formatCalendarDate(dateKey: string): string {
  // Guard against an accidental full timestamp: taking the date part keeps
  // this correct rather than silently reintroducing the shift.
  const dayOnly = dateKey.slice(0, 10);
  return format(`${dayOnly}T00:00:00Z`, 'UTC', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * `'2026-07-19'` for an instant, in a zone.
 *
 * Used to decide which devotional is "today's". `toISOString().slice(0,10)`
 * would answer in UTC, which is a different day from the user's for a
 * meaningful part of every 24 hours — the today card would go blank in the
 * evening in Chicago and early in the morning in Sydney. `en-CA` is used
 * because it formats as `YYYY-MM-DD`, matching the `date` column's shape
 * exactly.
 */
export function dateKeyInZone(instant: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: safeZone(zone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * The `0=Sunday..6=Saturday` weekday of an instant, in a zone — the same
 * convention `activeDays` uses (migration 1720000000000), so the two can
 * be compared without an off-by-one at the boundary.
 */
export function weekdayInZone(instant: Date, zone: string): number {
  const name = format(instant.toISOString(), zone, { weekday: 'short' });
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return index >= 0 ? index : instant.getUTCDay();
}

/* ===================================================================== *
 * Zone arithmetic for the calendar grid (Epic M, #255)
 *
 * Everything above formats an instant. Everything below does the harder
 * job the grid needs: converting *between* a calendar day in a zone and
 * the instants that day spans.
 *
 * ## Why the grid needs this at all
 *
 * A calendar grid holds two kinds of value that are both `string` and are
 * not the same kind of thing:
 *
 *  - a **calendar day** (`'2026-07-19'`) — what a grid *cell* is;
 *  - an **instant** (`'2026-07-19T14:00:00Z'`) — what a busy *block* is.
 *
 * `formatCalendarDate` above exists because conflating the two rendered
 * every archive row a day early. A grid hits the same confusion harder,
 * because it has to place instants *inside* cells: the question "does this
 * busy block belong to Sunday's column, and how far down it?" is a
 * question about where the zone's midnight boundaries fall, and midnight
 * is not a fixed UTC offset from anything.
 *
 * ## And why it cannot be done with `Date` arithmetic
 *
 * `new Date(dayStart.getTime() + 24 * 3600_000)` is wrong twice a year.
 * A calendar day in a zone with DST is 23 or 25 hours long, so that
 * expression lands an hour inside the previous day or an hour into the
 * next one — and the bug is invisible for 363 days. Every span below is
 * therefore *measured* (`dayStartInstant(next) - dayStartInstant(this)`)
 * rather than assumed.
 * ===================================================================== */

/** The `YYYY-MM-DD` key that identifies a grid cell. Never zone-converted; see `formatCalendarDate`. */
export type DateKey = string;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** `'2026-07-19'` -> `{ year: 2026, month: 7, day: 19 }`. Pure string surgery — no `Date`, so no zone can leak in. */
export function dateKeyParts(dateKey: DateKey): DateParts {
  const [y, m, d] = dateKey.slice(0, 10).split('-');
  return {
    year: Number.parseInt(y ?? '', 10),
    month: Number.parseInt(m ?? '', 10),
    day: Number.parseInt(d ?? '', 10),
  };
}

/**
 * Calendar-day arithmetic: `addDays('2026-03-07', 1) === '2026-03-08'`.
 *
 * Done in UTC deliberately. UTC has no DST, so "add 86,400,000 ms" and
 * "add one calendar day" are the same operation there and only there —
 * which is exactly why the *day boundaries* below must be computed
 * separately, in the user's zone. This function moves between cell
 * identities; it says nothing about how long those days are.
 */
export function addDays(dateKey: DateKey, delta: number): DateKey {
  const { year, month, day } = dateKeyParts(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

/** `0=Sunday..6=Saturday` for a calendar day. A property of the date itself, so no zone is involved. */
export function weekdayOfDateKey(dateKey: DateKey): number {
  const { year, month, day } = dateKeyParts(dateKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The zone's UTC offset, in ms, *at a given instant*.
 *
 * Offsets are a function of the instant, not of the zone — `America/Chicago`
 * is -5h in July and -6h in January. Anything that treats a zone as having
 * one offset is a DST bug waiting for its date.
 *
 * The trick: format the instant in the target zone, then read those
 * wall-clock fields back as if they were UTC. The gap between that and the
 * real instant is the offset.
 */
export function zoneOffsetMs(instant: Date, zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeZone(zone),
      // `hourCycle: 'h23'` rather than `hour12: false`: the latter yields
      // hour "24" for midnight in some engines, which `Date.UTC` then
      // rolls into the next day and puts the offset out by 24 hours.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);

    const field = (type: string) =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);

    const asIfUtc = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
    );
    if (Number.isNaN(asIfUtc)) return 0;
    return asIfUtc - instant.getTime();
  } catch {
    return 0;
  }
}

/**
 * The instant at which a given wall-clock time occurs in a zone.
 *
 * Two passes, because this is a fixed-point problem: the offset depends on
 * the instant, and the instant is what we are solving for. The first guess
 * uses the offset at the naive-UTC reading of the wall clock; the second
 * corrects it using the offset that actually applies at that guess. One
 * correction is sufficient everywhere real zones exist — DST shifts are at
 * most a couple of hours and never stack.
 *
 * A wall-clock time that does not exist (02:30 on a spring-forward day)
 * resolves to the instant the clock jumped to, which is the only sensible
 * answer and, importantly, is *stable*: it never returns NaN and never
 * silently lands on the previous day.
 */
export function zonedTimeToInstant(
  dateKey: DateKey,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const { year, month, day } = dateKeyParts(dateKey);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = naive - zoneOffsetMs(new Date(naive), zone);
  const corrected = naive - zoneOffsetMs(new Date(firstGuess), zone);
  return new Date(corrected);
}

/** The instant a calendar day begins in a zone — i.e. that day's midnight, wherever it actually falls. */
export function dayStartInstant(dateKey: DateKey, zone: string): Date {
  return zonedTimeToInstant(dateKey, 0, 0, zone);
}

/**
 * How long a calendar day actually is, in ms.
 *
 * **Measured, never assumed.** 82,800,000 on a spring-forward day and
 * 90,000,000 on a fall-back one. Every block position in the grid is a
 * fraction of this value, which is what keeps blocks aligned to the hour
 * axis on the two days a year that a hardcoded 24 would misplace them.
 */
export function dayLengthMs(dateKey: DateKey, zone: string): number {
  return dayStartInstant(addDays(dateKey, 1), zone).getTime() - dayStartInstant(dateKey, zone).getTime();
}
