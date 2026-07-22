/**
 * The view toggle and the period navigation (M5, #255).
 *
 * ## Native radios, styled — not buttons with `aria-pressed`
 *
 * Day/week/month is a single choice from three, which is what a radio
 * group *is*. Using real `<input type="radio">`s means arrow-key movement
 * between the options, the group's accessible name from the `<legend>`,
 * and the selected state announced as "selected" rather than "pressed" —
 * all from the platform, none of it re-implemented with `onKeyDown` and
 * `tabIndex`, which is where hand-rolled toggles quietly lose keyboard
 * support.
 *
 * ## Why these controls live outside the card's state branches
 *
 * They render in every state, including `error`. A user whose free/busy
 * read failed can still switch to the week and see the slots Wellspring has
 * booked — those come from our own table and did not fail. Controls that
 * vanished with the data would strand them on the broken view.
 */
import type { CalendarViewMode } from '../../../lib/calendarGrid';
import { VIEW_LABELS, VIEW_MODES } from '../../../lib/calendarGrid';

export function CalendarControls({
  mode,
  onModeChange,
  periodLabel,
  onShift,
  onToday,
  atToday,
}: {
  mode: CalendarViewMode;
  onModeChange: (mode: CalendarViewMode) => void;
  /** `'July 2026'` / `'Sunday, July 19'` — the period currently drawn. */
  periodLabel: string;
  onShift: (delta: number) => void;
  onToday: () => void;
  /** Suppresses "Today" when it would do nothing (docs/05 P7). */
  atToday: boolean;
}) {
  return (
    <div className="cal-controls">
      <fieldset className="cal-modes">
        <legend className="visually-hidden">Calendar view</legend>
        {VIEW_MODES.map((value) => (
          <label key={value} className={value === mode ? 'cal-mode is-selected' : 'cal-mode'}>
            <input
              type="radio"
              name="calendar-view"
              value={value}
              checked={value === mode}
              onChange={() => onModeChange(value)}
              className="visually-hidden"
            />
            {VIEW_LABELS[value]}
          </label>
        ))}
      </fieldset>

      <div className="cal-nav">
        <button
          type="button"
          className="quiet"
          onClick={() => onShift(-1)}
          aria-label={`Previous ${VIEW_LABELS[mode].toLowerCase()}`}
        >
          ‹
        </button>
        {/*
          A live region, because the two arrows change the whole grid
          beneath them and a screen-reader user who pressed one otherwise
          gets no confirmation that anything moved.
        */}
        <p className="cal-period" role="status">
          {periodLabel}
        </p>
        <button
          type="button"
          className="quiet"
          onClick={() => onShift(1)}
          aria-label={`Next ${VIEW_LABELS[mode].toLowerCase()}`}
        >
          ›
        </button>
        {!atToday && (
          <button type="button" className="secondary cal-today" onClick={onToday}>
            Today
          </button>
        )}
      </div>
    </div>
  );
}
