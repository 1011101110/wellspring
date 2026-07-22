/**
 * What Wellspring has booked and not yet delivered (L4, issue #240).
 *
 * "Trust in an agent that books meetings comes from being able to inspect
 * what it booked" — so each row shows the real time, the real theme, the
 * real Meet link, and admits when Wellspring has moved the event.
 *
 * Times are rendered with their zone abbreviation attached
 * (`formatTimeWithZone`), never bare. See `lib/datetime.ts` for why: the
 * profile timezone is not exposed by any endpoint today, so labelling the
 * zone we did use is what makes the displayed time a claim the user can
 * check rather than one they must trust.
 */
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { formatDay, formatTimeWithZone } from '../../lib/datetime';
import { rescheduleNote, sortByStart } from '../../lib/upcoming';

export function UpcomingList({
  events,
  zone,
}: {
  events: readonly UpcomingCalendarEvent[];
  zone: string;
}) {
  return (
    <ul className="dash-list">
      {sortByStart(events).map((event) => {
        const moved = rescheduleNote(event.rescheduleCount);
        return (
          <li key={event.id} className="dash-row">
            <p className="readout">{formatDay(event.gapStartAt, zone)}</p>
            <p className="dash-row-time">
              {formatTimeWithZone(event.gapStartAt, zone)}
              {' – '}
              {formatTimeWithZone(event.gapEndAt, zone)}
            </p>
            {event.devotional ? (
              <>
                <p className="dash-row-theme">{event.devotional.theme}</p>
                <p className="hint">{event.devotional.cardSummary}</p>
              </>
            ) : (
              /*
               * A booked slot whose devotional has not been generated yet
               * is the normal state for anything more than a day out —
               * generation happens on the morning of. Saying so beats an
               * empty space the user has to interpret.
               */
              <p className="hint">Wellspring will write this one closer to the time.</p>
            )}
            {moved && <p className="hint">{moved}</p>}
            {event.meetUri && (
              <a
                className="row-link"
                href={event.meetUri}
                target="_blank"
                rel="noreferrer noopener"
              >
                Join the meeting
                <span className="visually-hidden">
                  {' '}
                  on {formatDay(event.gapStartAt, zone)} (opens in a new tab)
                </span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
