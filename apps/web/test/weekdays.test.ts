import { describe, expect, it } from 'vitest';
import { WEEKDAYS_SUNDAY_FIRST, toggleDay } from '../src/lib/weekdays';

describe('WEEKDAYS_SUNDAY_FIRST', () => {
  it('covers all seven wire values exactly once', () => {
    expect([...WEEKDAYS_SUNDAY_FIRST].map((d) => d.value).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('presents Sunday first — it is the centre of a Christian week, not its leftover', () => {
    // #262. Sunday was LAST here, which in English reading order is where
    // the afterthought goes. The display order now matches the wire's own
    // Sunday=0 rather than disagreeing with it for a reason (a
    // workday-oriented product) this one is not.
    expect(WEEKDAYS_SUNDAY_FIRST[0]).toMatchObject({ value: 0, fullName: 'Sunday' });
    expect(WEEKDAYS_SUNDAY_FIRST[6]).toMatchObject({ value: 6, fullName: 'Saturday' });
  });

  it('gives every day a full spoken name, since the initials are ambiguous', () => {
    const initials = WEEKDAYS_SUNDAY_FIRST.map((d) => d.initial);
    expect(initials).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(new Set(WEEKDAYS_SUNDAY_FIRST.map((d) => d.fullName)).size).toBe(7);
  });
});

describe('toggleDay', () => {
  it('adds a day and keeps the set sorted', () => {
    expect(toggleDay(0, [1, 2, 3])).toEqual([0, 1, 2, 3]);
    expect(toggleDay(6, [1, 2])).toEqual([1, 2, 6]);
  });

  it('removes a day', () => {
    expect(toggleDay(3, [1, 2, 3, 4, 5])).toEqual([1, 2, 4, 5]);
  });

  it('refuses to remove the last day', () => {
    expect(toggleDay(3, [3])).toBeNull();
  });

  it('does not mutate the input', () => {
    const days = [1, 2, 3];
    toggleDay(4, days);
    toggleDay(1, days);
    expect(days).toEqual([1, 2, 3]);
  });
});
