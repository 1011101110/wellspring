/**
 * The monthly recap (L7, issue #243) — first client consumer of #96.
 *
 * The endpoint has been live and rendered by no client, which #243 calls
 * "this project's most reliably embarrassing category". This is the fix.
 *
 * ## What is deliberately not rendered
 *
 * `MonthlyRecapResponseData` carries `sessionsCount` — an integer, right
 * there in the payload, and it is **not shown**. docs/14 §5.10 and #243
 * are explicit: the recap is the narrative the endpoint produces, not a
 * completion percentage, and "no counts on the dashboard at all; if a
 * number appears, it needs a formation argument, not an engagement one."
 *
 * A count of sessions is exactly the engagement argument. Rendering "You
 * completed 12 sessions in June" turns a month of quiet formation into a
 * score, and implicitly into a comparison with the month before and with
 * the number of days that were available. `sessionsCount` is used only to
 * decide whether there is a month worth narrating at all — a threshold,
 * not a display.
 *
 * `recurringPassages` is text, not tally, and is shown: "you kept coming
 * back to Psalm 23" is a formation observation. `heavyWeek.label` is
 * likewise a phrase, never a band number (docs/05 P5).
 */
import type { MonthlyRecapResponseData } from '@kairos/shared-contracts';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * "Your June recap" — and "Your December 2025 recap" in January.
 *
 * The card always shows the month that has *finished*, so a December
 * recap is only ever displayed during January, i.e. in a different
 * calendar year than the one it covers. That is the single case where the
 * bare month name is ambiguous, so it is the single case that gets a year.
 * Adding one year-round would be noise on the other eleven months.
 */
export function recapTitle(year: number, month: number): string {
  const name = MONTH_NAMES[month - 1];
  if (!name) return 'Your recap';
  return month === 12 ? `Your ${name} ${year} recap` : `Your ${name} recap`;
}

export function RecapCardBody({ recap }: { recap: MonthlyRecapResponseData }) {
  return (
    <>
      <p>{recap.narrative}</p>

      {recap.recurringPassages.length > 0 && (
        <p className="hint">
          You kept returning to {recap.recurringPassages.join(', ')}.
        </p>
      )}

      {recap.heavyWeek && (
        /*
         * A phrase about a week that was heavy — not a score for it, and
         * not framed as a week the user handled badly. Foundation §9:
         * bands are never a verdict.
         */
        <p className="hint">{recap.heavyWeek.label}</p>
      )}
    </>
  );
}
