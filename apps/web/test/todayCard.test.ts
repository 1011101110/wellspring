import { describe, expect, it } from 'vitest';
import type { DevotionalCard, UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { deriveTodayState, TODAY_HEADLINES } from '../src/lib/todayCard';

const CHICAGO = 'America/Chicago';

function card(overrides: Partial<DevotionalCard> = {}): DevotionalCard {
  return {
    id: 'd1',
    date: '2026-07-20',
    theme: 'Rest',
    cardSummary: 'A short summary.',
    format: 'short',
    createdAt: '2026-07-20T12:00:00Z',
    completedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<UpcomingCalendarEvent> = {}): UpcomingCalendarEvent {
  return {
    id: 'e1',
    gapStartAt: '2026-07-20T14:00:00Z',
    gapEndAt: '2026-07-20T14:15:00Z',
    meetUri: null,
    rescheduleCount: 0,
    devotional: null,
    ...overrides,
  };
}

// 2026-07-20T18:00:00Z is the afternoon of the 20th in Chicago.
const NOW = new Date('2026-07-20T18:00:00Z');

describe('deriveTodayState', () => {
  it('reports a completed devotional when today’s session was finished', () => {
    const state = deriveTodayState({
      devotionals: [card({ completedAt: '2026-07-20T13:00:00Z' })],
      events: [],
      now: NOW,
      zone: CHICAGO,
    });
    expect(state).toMatchObject({ kind: 'completed' });
  });

  it('reports ready when today’s devotional exists but was not completed', () => {
    const state = deriveTodayState({
      devotionals: [card()],
      events: [],
      now: NOW,
      zone: CHICAGO,
    });
    expect(state).toMatchObject({ kind: 'ready' });
  });

  it('prefers the devotional over the event when both exist today', () => {
    const state = deriveTodayState({
      devotionals: [card()],
      events: [event()],
      now: NOW,
      zone: CHICAGO,
    });
    expect(state.kind).toBe('ready');
  });

  it('reports the booked slot when nothing is generated yet', () => {
    const state = deriveTodayState({
      devotionals: [],
      events: [event()],
      now: NOW,
      zone: CHICAGO,
    });
    expect(state).toMatchObject({ kind: 'scheduled' });
  });

  it('falls back to the open state when nothing is happening today', () => {
    const state = deriveTodayState({ devotionals: [], events: [], now: NOW, zone: CHICAGO });
    expect(state.kind).toBe('open');
  });

  it('ignores devotionals and events belonging to other days', () => {
    const state = deriveTodayState({
      devotionals: [card({ date: '2026-07-19' })],
      events: [event({ gapStartAt: '2026-07-22T14:00:00Z', gapEndAt: '2026-07-22T14:15:00Z' })],
      now: NOW,
      zone: CHICAGO,
    });
    expect(state.kind).toBe('open');
  });

  it('decides "today" in the user’s zone, not UTC', () => {
    // Late evening on the 19th in Chicago is already the 20th in UTC. The
    // user's today is the 19th, so the 19th's devotional is the one that
    // should surface — a UTC-based match would show the wrong day's card
    // (or none at all).
    const lateEvening = new Date('2026-07-20T02:00:00Z');
    const state = deriveTodayState({
      devotionals: [card({ date: '2026-07-19' })],
      events: [],
      now: lateEvening,
      zone: CHICAGO,
    });
    expect(state).toMatchObject({ kind: 'ready' });
  });
});

describe('the no-streaks constraint (docs/14 §5.10, #243)', () => {
  it('says nothing about counts, streaks, or missed sessions in any headline', () => {
    // The guard is on the copy a user can actually see. If a headline is
    // ever reworded into engagement grammar, this fails.
    const forbidden = /streak|day[s]? in a row|missed|behind|\d+%|\bkeep it up\b/i;
    for (const headline of Object.values(TODAY_HEADLINES)) {
      expect(headline).not.toMatch(forbidden);
    }
  });

  it('treats a user returning after a long gap identically to a daily user', () => {
    // No history is passed to the derivation at all, so a skipped week
    // cannot influence the card. This asserts the *shape* of that
    // guarantee: the same inputs for today produce the same state
    // regardless of what came before, because what came before is not an
    // input.
    const returning = deriveTodayState({
      devotionals: [card({ date: '2026-01-01' }), card({ id: 'd2' })],
      events: [],
      now: NOW,
      zone: CHICAGO,
    });
    const daily = deriveTodayState({
      devotionals: [card({ id: 'd2' })],
      events: [],
      now: NOW,
      zone: CHICAGO,
    });
    expect(returning.kind).toBe(daily.kind);
  });
});
