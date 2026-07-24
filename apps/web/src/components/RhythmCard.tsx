import type { Rhythm } from '@kairos/shared-contracts';
import {
  clampMinPerWeek,
  minPerWeekLabel,
  minPerWeekOptions,
  rhythmStatusLine,
} from '../lib/rhythm';

/**
 * "Your rhythm" (P8 #327): the transparency card that makes the adaptive
 * engine trustworthy instead of spooky — what the rhythm currently is and
 * why, in words (lib/rhythm.ts owns the prose; §9 rules documented and
 * tested there), plus the two controls the epic promises:
 *
 *  - **"Keep my schedule fixed"** — `adaptiveEnabled`, inverted: the
 *    label names the USER'S outcome, not our flag.
 *  - **"Never fewer than N days a week"** — `minPerWeek`, options driven
 *    by `minPerWeekOptions` so 1..7-and-under-the-active-day-count is
 *    unrepresentable rather than merely validated.
 *
 * Epic L rule #1 (no decorative UI, #225 lesson / #246 pattern): both
 * controls persist immediately through the callbacks (which PUT and hand
 * back the server's response), and everything rendered here comes from
 * the `rhythm` object of the LAST response — never local state. That is
 * also why there is no useState in this file.
 *
 * `rhythm` absent (older server, failed parse) → render NOTHING, not a
 * placeholder control (#244 policy).
 *
 * A11y: native checkbox/select with real `<label htmlFor>`, state carried
 * in words (the status line and hints), never color alone.
 */
export function RhythmCard({
  rhythm,
  activeDaysCount,
  busy,
  onToggleScheduleFixed,
  onChangeMinPerWeek,
}: {
  rhythm: Rhythm | undefined;
  /** |activeDays| from the same preferences response — the ceiling the floor control must stay under. */
  activeDaysCount: number;
  busy: boolean;
  /** `true` = "keep my schedule fixed" (persists `adaptiveEnabled: !next`). */
  onToggleScheduleFixed: (next: boolean) => void;
  onChangeMinPerWeek: (next: number) => void;
}) {
  if (!rhythm) return null;

  const statusLine = rhythmStatusLine(rhythm);
  const fixed = rhythm.mode === 'fixed';

  return (
    <fieldset className="field">
      <legend>Your rhythm</legend>
      {/* A sentence, not a label — `rhythm-status` opts out of the eyebrow
          treatment `.readout` carries under the design system (§03). */}
      {statusLine && <p className="readout rhythm-status">{statusLine}</p>}

      <label className="row" htmlFor="settings-rhythm-fixed">
        <input
          id="settings-rhythm-fixed"
          type="checkbox"
          checked={fixed}
          disabled={busy}
          aria-describedby="settings-rhythm-fixed-hint"
          onChange={(e) => onToggleScheduleFixed(e.target.checked)}
        />
        <span>Keep my schedule fixed</span>
      </label>
      <p className="hint" id="settings-rhythm-fixed-hint">
        {fixed
          ? 'Wellspring schedules exactly the days you chose, and never adjusts them.'
          : 'Wellspring gently adjusts how many of your chosen days get a devotional, easing back when life is full and adding mornings again as you return. Your days and window are always yours.'}
      </p>

      <div className="control">
        <label htmlFor="settings-rhythm-min">Never fewer than</label>
        <select
          id="settings-rhythm-min"
          value={clampMinPerWeek(rhythm.minPerWeek, activeDaysCount)}
          disabled={busy}
          aria-describedby="settings-rhythm-min-hint"
          onChange={(e) => onChangeMinPerWeek(Number(e.target.value))}
        >
          {minPerWeekOptions(activeDaysCount).map((n) => (
            <option key={n} value={n}>
              {minPerWeekLabel(n)}
            </option>
          ))}
        </select>
        <p className="hint" id="settings-rhythm-min-hint">
          However quiet things get, Wellspring keeps at least this many standing invitations each
          week.
        </p>
      </div>
    </fieldset>
  );
}
