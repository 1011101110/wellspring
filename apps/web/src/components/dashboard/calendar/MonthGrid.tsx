/**
 * The month view (M4, #255).
 *
 * ## A real `<table>`, because a month *is* one
 *
 * Seven labelled columns, six rows, one datum per intersection. That is a
 * data table, and marking it up as one gives screen-reader users column
 * headers announced with each cell ("Wednesday, 22, has commitments") and
 * table navigation keys — for free, and correctly. A `<div>` grid with
 * `aria-` attributes re-implements the same thing worse; this is the one
 * view in the feature where the native element is the right answer.
 *
 * The visible `<caption>` names the month, so the table is not a floating
 * set of numbers whose period the user has to infer from the toggle above.
 *
 * ## What this view deliberately does not render
 *
 * No busy count, no busy-minutes total, no proportion of the day, no
 * shading ramp, and no month-level aggregate of any kind. The full
 * argument is on `MonthCell` in `lib/calendarGrid.ts`; the short version
 * is that a heatmap is a metric about the user's life handed back to them,
 * which `docs/14 §5.10` and Foundation §9 rule out, and that the data to
 * build one is available here and is not used.
 *
 * Each cell therefore says at most three things: which day it is, whether
 * *anything* is committed (binary — a day with one meeting draws exactly
 * like a day with nine), and which Wellspring slots sit on it. Wellspring's own
 * slots are the exception to the opacity because we created them.
 */
import { formatTime } from '../../../lib/datetime';
import type { MonthCell } from '../../../lib/calendarGrid';

const WEEKDAYS = [
  { short: 'Sun', long: 'Sunday' },
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
] as const;

const ROW_LENGTH = 7;

function chunkIntoWeeks(cells: readonly MonthCell[]): readonly (readonly MonthCell[])[] {
  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += ROW_LENGTH) weeks.push(cells.slice(i, i + ROW_LENGTH));
  return weeks;
}

function CommitmentMark({ commitment }: { commitment: MonthCell['commitment'] }) {
  if (commitment === 'unknown') {
    return (
      <p className="cal-month-mark is-unknown">
        <span aria-hidden="true">·····</span>
        <span className="visually-hidden">not visible to Wellspring</span>
      </p>
    );
  }
  if (commitment === 'quiet') {
    /*
     * Nothing drawn, but the state is still *stated* for a screen reader.
     * "Nothing here" and "nothing announced" are different, and the second
     * one is how a blind user ends up unable to tell an open day from a
     * day the table failed to fill in.
     */
    return <span className="visually-hidden">nothing on your calendar</span>;
  }
  return (
    <p className="cal-month-mark is-committed">
      {/*
        One bar, always the same size. Not a fill proportional to the
        day — see the module header and `MonthCell`.
      */}
      <span aria-hidden="true" className="cal-month-bar" />
      <span className="visually-hidden">has commitments</span>
    </p>
  );
}

export function MonthGrid({
  cells,
  monthLabel,
  zone,
  todayKey,
}: {
  cells: readonly MonthCell[];
  /** `'July 2026'`. */
  monthLabel: string;
  zone: string;
  todayKey: string;
}) {
  return (
    <table className="cal-month">
      <caption>
        {monthLabel}
        <span className="visually-hidden"> — times in {zone}</span>
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map((day) => (
            <th key={day.short} scope="col">
              <span aria-hidden="true">{day.short}</span>
              <span className="visually-hidden">{day.long}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chunkIntoWeeks(cells).map((week) => (
          <tr key={week[0]?.dateKey ?? ''}>
            {week.map((cell) => {
              const isToday = cell.dateKey === todayKey;
              const classes = ['cal-month-cell'];
              if (!cell.inFocusMonth) classes.push('is-outside');
              if (isToday) classes.push('is-today');
              return (
                <td key={cell.dateKey} className={classes.join(' ')}>
                  <p className="cal-month-day">
                    {cell.dayLabel}
                    {/*
                      "Today" as a word, not only as a ring. A state
                      carried by a border alone is invisible in
                      high-contrast mode and silent to a screen reader.
                    */}
                    {isToday && <span className="cal-month-today"> Today</span>}
                    {!cell.inFocusMonth && (
                      <span className="visually-hidden"> (outside {monthLabel})</span>
                    )}
                  </p>

                  <CommitmentMark commitment={cell.commitment} />

                  {cell.kairos.length > 0 && (
                    <ul className="cal-month-kairos">
                      {cell.kairos.map((slot) => (
                        <li key={slot.eventId}>
                          <span className="visually-hidden">Wellspring devotional at </span>
                          <span className="cal-month-kairos-time">
                            {formatTime(slot.startIso, zone)}
                          </span>
                          {slot.theme && (
                            <span className="cal-month-kairos-theme">{slot.theme}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
