/**
 * The day/week view's visible window (N6, issue #265).
 *
 * These assert the geometry contract the CSS depends on. The rendered
 * consequence — that a 20-minute block is actually tall enough for its
 * label — is measured in `e2e/dashboard.a11y.spec.ts`, because that is a
 * property of the laid-out page and no unit test can see it (#264's whole
 * lesson).
 */
import { describe, expect, it } from 'vitest';
import { FULL_DAY_WINDOW, workdayWindow } from '../src/lib/calendarGrid';

describe('workdayWindow', () => {
  it('opens on the user’s hours with an hour of air either side', () => {
    // 9–5 becomes 8am–6pm: ten hours of twenty-four.
    expect(workdayWindow(9, 17)).toEqual({ offset: 8 / 24, zoom: 24 / 10 });
  });

  it('magnifies enough to matter — the point of the whole change', () => {
    // 34rem over 24h gave a 20-minute block ~12px against a 42px
    // scrollHeight, which is what sheared its label in half. 2.4x makes
    // that ~29px. The assertion is on the ratio rather than on pixels,
    // since pixels are the e2e suite's job.
    expect(workdayWindow(9, 17).zoom).toBeGreaterThan(2);
  });

  it('clamps at the ends of the day rather than producing a negative offset', () => {
    // Midnight start: the hour of padding would run off the top.
    expect(workdayWindow(0, 8).offset).toBe(0);
    // Late finish: padding would run past 24 and overstate the zoom.
    const late = workdayWindow(14, 23);
    expect(late.offset + 24 / late.zoom / 24).toBeLessThanOrEqual(1.0001);
  });

  it('refuses to zoom a window so wide there is nothing to gain', () => {
    expect(workdayWindow(1, 23)).toBe(FULL_DAY_WINDOW);
  });

  it('refuses to zoom a window so narrow that scrolling out becomes a chore', () => {
    expect(workdayWindow(9, 11)).toBe(FULL_DAY_WINDOW);
  });

  it('falls back to the whole day for nonsense rather than guessing', () => {
    // A bad zoom HIDES real commitments; refusing to zoom never does. So
    // every unclear case resolves toward showing more, not less.
    expect(workdayWindow(NaN, 17)).toBe(FULL_DAY_WINDOW);
    expect(workdayWindow(9, NaN)).toBe(FULL_DAY_WINDOW);
    expect(workdayWindow(17, 9)).toBe(FULL_DAY_WINDOW);
  });

  it('returns the FULL_DAY_WINDOW constant itself on fallback, not a copy', () => {
    // CalendarCard tests identity to decide whether to offer the "show
    // the whole day" toggle at all — a control that changes nothing does
    // not ship (docs/05 P7). An equal-but-distinct object would make that
    // button appear and do nothing.
    expect(workdayWindow(1, 23)).toBe(FULL_DAY_WINDOW);
    expect(FULL_DAY_WINDOW).toEqual({ offset: 0, zoom: 1 });
  });

  it('never crops: the window is a starting position, not a range limit', () => {
    // There is no `end` in TimeWindow by design. Everything outside the
    // window is still rendered and still scrollable — a user with a 6am
    // habit must be able to find it. This test exists to make that a
    // stated contract rather than an accident of the type.
    const w = workdayWindow(9, 17);
    expect(Object.keys(w).sort()).toEqual(['offset', 'zoom']);
  });
});
