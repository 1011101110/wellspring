import { useState } from 'react';
import { WEEKDAYS_SUNDAY_FIRST, toggleDay } from '../lib/weekdays';

/**
 * The day-of-week selector — the web counterpart of iOS's
 * `WeekdayCircleRow` (K3, #189), down to the same three-signal selected
 * state and the same refusal of the last deselection.
 *
 * ## State is not signalled by color alone
 *
 * `session-a11y`'s bar is WCAG AA, and 1.4.1 Use of Color applies to this
 * row exactly as it does to the session page. Selected carries three
 * signals, only one of which is color:
 *   1. **fill** — solid vs. empty. A luminance inversion, not a hue
 *      change, so it survives grayscale and every form of color vision
 *      deficiency.
 *   2. **weight** — semibold vs. regular.
 *   3. **border** — none vs. a visible ring, which also keeps an
 *      unselected circle a visible, obviously-clickable object rather
 *      than bare text floating in the row.
 *
 * These are real `<button>`s inside a `<fieldset>` with a `<legend>`, not
 * divs wearing click handlers: they are tabbable, operable with
 * Space/Enter for free, and announce themselves as toggles via
 * `aria-pressed`. The accessible name is the whole word — spoken aloud
 * the single-letter cue is useless, since position is what disambiguates
 * the two Ts and the two Ss.
 */
export function WeekdayRow({
  days,
  onChange,
  idPrefix,
}: {
  days: number[];
  onChange: (next: number[]) => void;
  idPrefix: string;
}) {
  const [refused, setRefused] = useState(false);

  function handleToggle(day: number) {
    const next = toggleDay(day, days);
    if (next === null) {
      // A control that silently ignores a click is indistinguishable from
      // a broken one, so the refusal is announced rather than swallowed —
      // and the notice below is an `aria-live` region so the feedback is
      // not visual-only.
      setRefused(true);
      return;
    }
    setRefused(false);
    onChange(next);
  }

  return (
    <fieldset className="field">
      <legend>Days</legend>
      <div className="weekday-row">
        {WEEKDAYS_SUNDAY_FIRST.map((day) => {
          const selected = days.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              id={`${idPrefix}-day-${day.value}`}
              className={`weekday${selected ? ' is-selected' : ''}`}
              aria-pressed={selected}
              onClick={() => handleToggle(day.value)}
            >
              <span aria-hidden="true">{day.initial}</span>
              <span className="visually-hidden">{day.fullName}</span>
            </button>
          );
        })}
      </div>
      <p className={`hint${refused ? ' hint-emphasis' : ''}`} role="status">
        {refused
          ? 'That is your only selected day. Choose another day before turning this one off.'
          : 'Wellspring needs at least one day.'}
      </p>
    </fieldset>
  );
}
