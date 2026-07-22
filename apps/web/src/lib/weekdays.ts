/**
 * Day-of-week naming and the day-selection rule, kept out of the
 * component for the same reason `WeekdaySelection` is kept out of
 * `WeekdayCircleRow.swift` (K3, #189): the interesting behavior is a
 * single pure question — given these days and this click, what is the new
 * set? — and its failure mode is a 400 from the API, so it gets a unit
 * test instead of a browser.
 */

/** Wire convention: 0=Sunday..6=Saturday (migration 1720000000000). */
export interface Weekday {
  value: number;
  /** Drawn inside the circle. Position disambiguates the two Ts and two Ss for the eye. */
  initial: string;
  /**
   * The whole word, used as the control's accessible name. Spoken aloud
   * the single-letter cue is gone entirely — "T, selected. T, not
   * selected." is unusable — so screen readers get the full name and only
   * the pixels get the abbreviation.
   */
  fullName: string;
}

/**
 * Display order, Sunday first (N3, #262).
 *
 * This was Monday-first, on the reasoning that Wellspring is a
 * workday-oriented product. That reasoning is what put Sunday **last** —
 * the position an English-speaking reader gives to the afterthought — in
 * a Christian devotional app, where Sunday is the week's centre and not
 * its leftover. Sunday-first is also the ordering the wire already uses
 * (0=Sunday), so the display no longer disagrees with the protocol for a
 * reason the product does not hold.
 */
export const WEEKDAYS_SUNDAY_FIRST: readonly Weekday[] = [
  { value: 0, initial: 'S', fullName: 'Sunday' },
  { value: 1, initial: 'M', fullName: 'Monday' },
  { value: 2, initial: 'T', fullName: 'Tuesday' },
  { value: 3, initial: 'W', fullName: 'Wednesday' },
  { value: 4, initial: 'T', fullName: 'Thursday' },
  { value: 5, initial: 'F', fullName: 'Friday' },
  { value: 6, initial: 'S', fullName: 'Saturday' },
] as const;

/**
 * The set produced by clicking `day`, or `null` if the click is refused.
 *
 * `null` means "this would have emptied the selection". Refused at the
 * click rather than repaired afterwards by `validate()`: that repair falls
 * back to Mon–Fri, which is correct for a legacy row and wrong as an
 * interaction — a user whose only day is Wednesday would click Wednesday
 * once and watch five days light up, Wednesday among them. One click, six
 * things change, and the thing they asked to remove is still on. There is
 * no reading of that which looks deliberate.
 */
export function toggleDay(day: number, days: readonly number[]): number[] | null {
  if (!days.includes(day)) return [...days, day].sort((a, b) => a - b);
  if (days.length <= 1) return null;
  return days.filter((d) => d !== day);
}
