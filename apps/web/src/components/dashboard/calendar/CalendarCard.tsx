/**
 * The calendar card — the dashboard surface for M2–M5 (#255).
 *
 * Owns the two pieces of state the views are a function of (which mode,
 * which period) and the one fetch they need. Everything below it is
 * presentational, and everything it decides is computed by
 * `lib/calendarGrid.ts`.
 *
 * ## Two sources, two independent failure modes
 *
 * Busy blocks come from `GET /v1/calendar/freebusy` (this card's own
 * fetch). Wellspring's slots come from `GET /v1/calendar-events/upcoming`,
 * which the dashboard has already loaded for the "Coming up" card — so
 * they are passed in rather than fetched again. They are passed as a
 * *knowledge* value, not a bare array, for the same reason `busy` is: an
 * empty array from a failed read would draw as "Wellspring has nothing
 * booked", and that is a claim we would be making without evidence.
 *
 * ## The upcoming endpoint only looks forward
 *
 * `/v1/calendar-events/upcoming` is, by its route name, upcoming-only. So
 * a month view scrolled back to last month shows that month's busy days
 * and none of the Wellspring slots that happened in it. That is a real gap
 * rather than a rendering choice, and the card says so instead of letting
 * a past month read as a month Wellspring ignored.
 */
import { useCallback, useMemo, useState } from 'react';
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { getFreeBusy } from '../../../api/calendar';
import { useCardData } from '../../../hooks/useCardData';
import { readyCard } from '../../../lib/cardState';
import { dateKeyInZone, type DateKey } from '../../../lib/datetime';
import {
  answersRange,
  eventsInRange,
  FULL_DAY_WINDOW,
  gridRange,
  monthCells,
  periodLabel,
  PRIVACY_NOTE,
  rangeContainsDay,
  resolveBusy,
  shiftAnchor,
  unknownBusyMessage,
  workdayWindow,
  type CalendarViewMode,
} from '../../../lib/calendarGrid';
import { CardFrame } from '../CardFrame';
import { CalendarControls } from './CalendarControls';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';

/** What the dashboard knows about Wellspring's own bookings. See the module header. */
export type KairosKnowledge =
  { kind: 'known'; events: readonly UpcomingCalendarEvent[] } | { kind: 'unknown' };

export function CalendarCard({
  zone,
  kairos,
  workdayStartHour,
  workdayEndHour,
  onOpenSettings,
  onConnectCalendar,
  now = () => new Date(),
}: {
  /** The profile zone (`preferences.timezone`), already resolved by the dashboard. */
  zone: string;
  kairos: KairosKnowledge;
  /**
   * The user's own window, which the day and week views open onto (#265).
   * Taken from the preferences the dashboard already holds rather than
   * fetched again, and passed as plain numbers so this component cannot
   * accidentally depend on the wider preferences payload.
   */
  workdayStartHour: number;
  workdayEndHour: number;
  onOpenSettings: () => void;
  onConnectCalendar: () => void;
  now?: () => Date;
}) {
  const todayKey: DateKey = dateKeyInZone(now(), zone);
  const [mode, setMode] = useState<CalendarViewMode>('day');
  const [anchorKey, setAnchorKey] = useState<DateKey>(todayKey);
  /*
   * #265: the grid spanned midnight to midnight in a fixed 34rem, so 58%
   * of the tallest element on the dashboard was empty night — in a
   * product whose premise is finding the gap in a workday. It opens on
   * the user's hours instead.
   *
   * An escape, not a crop: nothing outside the window is removed, and
   * this toggle (plus ordinary scrolling) reaches all of it. A user with
   * a 6am habit or a 9pm meeting must not have to wonder whether Wellspring
   * can see it.
   */
  const [showWholeDay, setShowWholeDay] = useState(false);

  /*
   * `workdayWindow` returns the FULL_DAY_WINDOW constant itself when the
   * user's hours are too wide or too narrow to be worth zooming, so
   * identity comparison is the honest test for "is there anything to
   * expand?" — and is why the toggle below hides itself rather than
   * appearing as a control that does nothing.
   */
  const preferredWindow = useMemo(
    () => workdayWindow(workdayStartHour, workdayEndHour),
    [workdayStartHour, workdayEndHour],
  );
  const windowIsMeaningful = preferredWindow !== FULL_DAY_WINDOW;

  const range = useMemo(() => gridRange(mode, anchorKey, zone), [mode, anchorKey, zone]);

  const card = useCardData(
    useCallback(
      async () => readyCard(await getFreeBusy(range.from, range.to)),
      [range.from, range.to],
    ),
    [range.from, range.to],
  );

  const events = kairos.kind === 'known' ? eventsInRange(kairos.events, range) : [];

  return (
    <CardFrame
      id="calendar"
      title="Your calendar"
      state={card.state}
      onRetry={card.reload}
      /*
       * Unreachable: the loader always returns `readyCard`, because a
       * calendar with nothing on it is a real answer ("nothing on your
       * calendar today") that the grid renders in place, not an empty
       * card. Required by the frame, so it says the true thing rather
       * than a placeholder nobody will read.
       */
      emptyMessage={<p className="hint">There is nothing to show for this period.</p>}
      headerAction={
        <CalendarControls
          mode={mode}
          onModeChange={setMode}
          periodLabel={periodLabel(mode, range, anchorKey)}
          onShift={(delta) => setAnchorKey((key) => shiftAnchor(mode, key, delta))}
          onToday={() => setAnchorKey(todayKey)}
          atToday={rangeContainsDay(range, todayKey)}
        />
      }
    >
      {(data) => {
        /*
         * The toggle fires overlapping requests and they can land out of
         * order; the contract echoes `range` on every variant precisely so
         * this check is possible. A response for the range we are no
         * longer showing is treated as still-loading rather than painted,
         * because a stale week drawn into a month grid is wrong in a way
         * that looks completely plausible.
         */
        if (!answersRange(data, range)) {
          return (
            <p className="hint" role="status">
              Loading…
            </p>
          );
        }

        const busy = resolveBusy(data);

        /*
         * A fully-unknown range with nothing of Wellspring's own to show
         * (N7, #266). When the calendar cannot be read AND Wellspring has
         * booked no slots in this range, every cell of the grid says the
         * same thing — "we don't know" — 42 times over on a month. The
         * degraded notice above already says it once, with the action
         * that fixes it, so the grid is pure repetition and gets
         * suppressed.
         *
         * Gated on `events.length === 0` so the partial case survives: a
         * user who connected, got slots booked, then revoked still has
         * real Wellspring slots worth drawing, and the grid stays to draw
         * them. And gated on `busy.kind === 'unknown'`, so a connected
         * user's calendar is untouched by this branch entirely.
         */
        const gridWouldSayNothing = busy.kind === 'unknown' && events.length === 0;
        if (gridWouldSayNothing) {
          return (
            <div className="notice notice-warn cal-degraded" role="status">
              <p>{unknownBusyMessage(busy.reason)}</p>
              {busy.reason === 'consent_disabled' ? (
                <button type="button" className="secondary" onClick={onOpenSettings}>
                  Open settings
                </button>
              ) : (
                <button type="button" className="secondary" onClick={onConnectCalendar}>
                  Connect Google Calendar
                </button>
              )}
            </div>
          );
        }

        return (
          <>
            {/*
              #265: this rendered above EVERY view, on every render.
              Repeated, a reassurance stops reading as reassurance and
              starts reading as a disclaimer — the thing a product says
              when it is nervous about what it is doing. It is shown where
              it does work: when Wellspring can actually see the calendar,
              which is the only time the question "what does it see?"
              is live. The degraded states below say something more
              specific about visibility anyway.
            */}
            {busy.kind === 'known' && <p className="hint cal-privacy">{PRIVACY_NOTE}</p>}

            {busy.kind === 'unknown' && (
              <div className="notice notice-warn cal-degraded" role="status">
                <p>{unknownBusyMessage(busy.reason)}</p>
                {/*
                 * The remedy differs by reason and each control does the
                 * real thing (docs/05 P7). A single "reconnect" button for
                 * both would send a user who merely turned the toggle off
                 * through an OAuth flow that changes nothing — Foundation
                 * §8: revoking a category does not revoke the grant.
                 */}
                {busy.reason === 'consent_disabled' ? (
                  <button type="button" className="secondary" onClick={onOpenSettings}>
                    Open settings
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={onConnectCalendar}>
                    Connect Google Calendar
                  </button>
                )}
              </div>
            )}

            {kairos.kind === 'unknown' && (
              <p className="notice notice-warn" role="status">
                Wellspring&rsquo;s own slots could not be loaded, so none are shown below. This does not
                mean nothing is booked.
              </p>
            )}

            {mode === 'month' ? (
              <>
                <MonthGrid
                  cells={monthCells(range, anchorKey, busy, events)}
                  monthLabel={periodLabel('month', range, anchorKey)}
                  zone={zone}
                  todayKey={todayKey}
                />
                {anchorKey.slice(0, 7) < todayKey.slice(0, 7) && (
                  <p className="hint">
                    Wellspring only keeps a forward-looking list of its own slots, so past months show
                    your commitments but not the devotionals that happened in them.
                  </p>
                )}
              </>
            ) : (
              <>
                <TimeGrid
                  range={range}
                  busy={busy}
                  events={events}
                  window={showWholeDay ? FULL_DAY_WINDOW : preferredWindow}
                />
                {/*
                  Only offered when it would actually do something —
                  `workdayWindow` falls back to the full day for a window
                  too wide or too narrow to be worth zooming, and a
                  control that changes nothing does not ship (docs/05 P7).
                */}
                {windowIsMeaningful && (
                  <button
                    type="button"
                    className="quiet cal-expand"
                    onClick={() => setShowWholeDay((v) => !v)}
                  >
                    {showWholeDay ? 'Show my hours' : 'Show the whole day'}
                  </button>
                )}
              </>
            )}

            {/*
              #265: "Times shown in {zone}" used to render under every
              view — a THIRD statement of a fact every block and day
              heading already carries via `formatTimeWithZone`, and which
              the travel-mismatch notice states again when it matters. The
              month view is the one place no time is rendered beside it,
              so it is the one place the sentence is doing work.
            */}
            {mode === 'month' && <p className="hint cal-zone">Times shown in {zone}.</p>}
          </>
        );
      }}
    </CardFrame>
  );
}
