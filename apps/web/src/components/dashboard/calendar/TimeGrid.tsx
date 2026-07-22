/**
 * The day and week views (M2, M3 — #255). One component, because a week
 * is seven day columns against the same vertical time axis and building
 * them separately would be two chances to get the DST arithmetic wrong.
 *
 * ## Structure, and why it is a list rather than a `role="grid"`
 *
 * Each day is a list item with its own heading; inside it, the busy and
 * Wellspring blocks are an **ordered list in chronological order**. Absolute
 * positioning moves them visually without touching DOM order, so a screen
 * reader reads each day's blocks earliest-first — which is the order the
 * day happens in, and the only reading order that makes sense.
 *
 * `role="grid"` was considered and rejected. A grid role promises a
 * two-dimensional cell structure with roving focus, and these blocks are
 * neither cells nor focusable: nothing here is interactive, because there
 * is no action to perform on a busy block (and a control that does nothing
 * does not ship — docs/05 P7). Announcing a grid we cannot navigate like
 * one is worse than announcing a list we can.
 *
 * The scroll container *is* focusable (`tabIndex={0}` + a group label), so
 * a keyboard user can reach and scroll it. That is the WCAG 2.1.1 fix for
 * a scrollable region, and it is the only tab stop the grid adds.
 *
 * ## Blocks are never distinguished by colour alone
 *
 * Busy is a hatched fill with the word "Busy"; a Wellspring slot is a solid
 * fill with a heavy left rule and its theme in text. Either survives
 * greyscale, high-contrast mode, and a screen reader, because the
 * difference is carried by pattern, border and words as well as hue.
 */
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { formatTime, formatTimeWithZone, formatWeekday, type DateKey } from '../../../lib/datetime';
import { useEffect, useRef } from 'react';
import {
  busySegmentsForDay,
  axisReferenceKey,
  FULL_DAY_WINDOW,
  hourRows,
  isDstTransitionDay,
  kairosSegmentsForDay,
  type BusyKnowledge,
  type GridRange,
  type KairosSegment,
  type TimeWindow,
} from '../../../lib/calendarGrid';

/**
 * `'2026-07-19'` -> `{ weekday: 'Sunday', date: 'Jul 19' }`.
 *
 * **Takes no zone, deliberately.** A cell's identity is a calendar day,
 * and converting it to a zone is the `formatCalendarDate` bug: parsed as
 * UTC midnight and rendered in Chicago, `'2026-07-19'` is the evening of
 * the 18th, so every column heading would name the day before the column
 * it sits above. Noon-UTC-in-UTC round-trips the same calendar day for
 * any zone on earth.
 */
function dayHeading(dateKey: DateKey): { weekday: string; date: string } {
  const noonish = `${dateKey}T12:00:00Z`;
  return {
    weekday: formatWeekday(noonish, 'UTC'),
    date: new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
    }).format(new Date(noonish)),
  };
}

function KairosBlock({ segment, zone }: { segment: KairosSegment; zone: string }) {
  return (
    <li
      className="cal-block cal-block-kairos"
      style={{ top: `${segment.top * 100}%`, height: `${segment.height * 100}%` }}
    >
      <span className="cal-block-kind">Wellspring</span>{' '}
      <span className="cal-block-time">
        {formatTime(segment.startIso, zone)}–{formatTimeWithZone(segment.endIso, zone)}
      </span>
      {segment.theme ? (
        <span className="cal-block-theme"> {segment.theme}</span>
      ) : (
        /*
         * The devotional is written on the morning of, so anything more
         * than a day out genuinely has no theme yet. Saying so beats a
         * labelled block with a blank label.
         */
        <span className="cal-block-theme"> — written closer to the time</span>
      )}
    </li>
  );
}

function BusyBlock({
  segment,
  zone,
}: {
  segment: ReturnType<typeof busySegmentsForDay>[number];
  zone: string;
}) {
  return (
    <li
      className="cal-block cal-block-busy"
      style={{ top: `${segment.top * 100}%`, height: `${segment.height * 100}%` }}
    >
      {/*
        "Busy" and a time, and nothing else — not because the title was
        stripped here, but because `freebusy.query` never sent one. See
        `PrivacyNote`, which says that to the user in the one place they
        will read it.
      */}
      <span className="cal-block-kind">Busy</span>{' '}
      <span className="cal-block-time">
        {formatTime(segment.startIso, zone)}–{formatTimeWithZone(segment.endIso, zone)}
      </span>
      {segment.continuesFromPreviousDay && (
        <span className="visually-hidden"> (started the day before)</span>
      )}
      {segment.continuesIntoNextDay && (
        <span className="visually-hidden"> (continues into the next day)</span>
      )}
    </li>
  );
}

export function TimeGrid({
  range,
  busy,
  events,
  window: timeWindow = FULL_DAY_WINDOW,
}: {
  range: GridRange;
  busy: BusyKnowledge;
  events: readonly UpcomingCalendarEvent[];
  /**
   * The slice of the day to show (#265). Defaults to the whole day, so a
   * caller that has no window — the states preview, a user with no stored
   * hours — gets the old behaviour rather than a guessed one.
   */
  window?: TimeWindow;
}) {
  const zone = range.zone;
  const scrollerRef = useRef<HTMLDivElement>(null);

  /*
   * Scroll rather than clip. The column is `zoom`x taller than its
   * container and everything outside the window is still rendered and
   * still reachable — a user with a 7am meeting can scroll up and find
   * it. Cropping would have hidden real commitments to make the layout
   * tidier, which is not a trade this product gets to make.
   *
   * Set imperatively on mount and whenever the window or range changes,
   * because `scrollTop` is DOM state with no declarative equivalent. It
   * is deliberately NOT re-applied on every render: doing so would yank a
   * user who had scrolled up to that 7am meeting back down again.
   */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = timeWindow.offset * el.scrollHeight;
  }, [timeWindow.offset, timeWindow.zoom, range.from, range.mode]);
  /*
   * Every column is sized to its OWN day's row count via `--cal-rows`, so
   * the blocks and the hour rules inside a column are always in step — the
   * DST arithmetic lives per day, not per view.
   *
   * The shared label gutter beside them cannot be right for every column
   * in a week that contains a transition; `axisReferenceKey` picks the one
   * it is right for most of. See its doc.
   */
  const axis = hourRows(axisReferenceKey(range.dayKeys, zone), zone);

  return (
    <div
      ref={scrollerRef}
      className="cal-timegrid"
      role="group"
      aria-label={`${range.mode === 'day' ? 'Day' : 'Week'} view, times in ${zone}`}
      tabIndex={0}
      style={{ ['--cal-zoom' as string]: String(timeWindow.zoom) }}
    >
      {/* A visual scale. Every block states its own times, so this is not the only place the hours appear. */}
      <ul className="cal-axis" aria-hidden="true">
        {axis.map((row) => (
          <li key={row.iso} className="cal-axis-hour" style={{ top: `${row.top * 100}%` }}>
            {row.label}
          </li>
        ))}
      </ul>

      <ol className="cal-days" data-mode={range.mode}>
        {range.dayKeys.map((dateKey) => {
          const heading = dayHeading(dateKey);
          const rows = hourRows(dateKey, zone).length;
          const kairos = kairosSegmentsForDay(events, dateKey, zone);
          const busySegments =
            busy.kind === 'known' ? busySegmentsForDay(busy.blocks, dateKey, zone) : [];
          const dst = isDstTransitionDay(dateKey, zone);

          return (
            <li key={dateKey} className="cal-day">
              <h3 className="cal-day-heading">
                <span className="cal-day-weekday">{heading.weekday}</span>{' '}
                <span className="cal-day-date">{heading.date}</span>
              </h3>

              <div className="cal-column" style={{ ['--cal-rows' as string]: String(rows) }}>
                {busy.kind === 'unknown' && (
                  /*
                   * A full-height "we could not read this" fill, not an
                   * empty column. An empty column is indistinguishable
                   * from a free day, which is the exact lie the contract's
                   * missing-`busy` design exists to prevent — and it would
                   * be reintroduced right here, at the pixel, if this
                   * branch drew nothing.
                   */
                  <p className="cal-unknown">
                    <span className="visually-hidden">
                      Wellspring cannot see whether you are busy on {heading.weekday} {heading.date}.
                    </span>
                    <span aria-hidden="true">Not visible to Wellspring</span>
                  </p>
                )}

                <ol className="cal-blocks">
                  {busySegments.map((segment) => (
                    <BusyBlock key={`b-${segment.startIso}`} segment={segment} zone={zone} />
                  ))}
                  {kairos.map((segment) => (
                    <KairosBlock key={segment.eventId} segment={segment} zone={zone} />
                  ))}
                </ol>

                {busy.kind === 'known' && busySegments.length === 0 && kairos.length === 0 && (
                  <p className="cal-open">
                    <span className="visually-hidden">
                      {heading.weekday} {heading.date}:{' '}
                    </span>
                    Nothing on your calendar
                  </p>
                )}
              </div>

              {dst && (
                /*
                 * Named rather than silently absorbed. The column really
                 * does have 23 or 25 hours on this day and the axis really
                 * does skip or repeat an hour; a user who notices deserves
                 * the reason rather than a rendering bug's worth of doubt.
                 */
                <p className="hint cal-dst">
                  Clocks change today, so this day is not 24 hours long.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
