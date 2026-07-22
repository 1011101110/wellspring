/**
 * N2 (#261): which passage the Today card shows, and what it claims about it.
 *
 * ## What is actually at risk here
 *
 * Not "does a verse render" — that is participation, and Test Plan §3.1
 * rule 4 says it is the wrong assertion. The two ways this feature goes
 * wrong in production are both about *meaning*:
 *
 *  1. A stale passage presented as today's. The user opens the dashboard,
 *     reads a verse under "There's room for a devotional whenever you want
 *     one", and reasonably concludes Wellspring chose it for them this
 *     morning. It is last Tuesday's. That is the #196 provenance rule
 *     broken by a missing caption.
 *  2. An invented passage. A fixture verse, a hardcoded "verse of the
 *     day", anything the system did not fetch byte-exact from YouVersion.
 *
 * So every test below asserts on `provenance` or on the absence of a
 * verse, and `previewScripture.test.ts` covers (2) by pinning the only
 * verse literal in the client to the fixture it was copied from.
 *
 * The `DevotionalCard` fixtures are built through the shared contract's
 * own type rather than as loose objects, so a change to the card shape
 * fails this file at compile time (rule 1).
 */
import { describe, expect, it } from 'vitest';
import type { DevotionalCard, UpcomingCalendarEvent, Verse } from '@kairos/shared-contracts';
import { anchorForToday, primaryVerse } from '../src/lib/scripture';
import { deriveTodayState, type TodayState } from '../src/lib/todayCard';

const CHICAGO = 'America/Chicago';
/** 2026-07-20T18:00:00Z is the afternoon of the 20th in Chicago. */
const NOW = new Date('2026-07-20T18:00:00Z');

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
    gapStartAt: '2026-07-20T22:00:00Z',
    gapEndAt: '2026-07-20T22:15:00Z',
    meetUri: null,
    rescheduleCount: 0,
    devotional: null,
    ...overrides,
  };
}

function verse(overrides: Partial<Verse> = {}): Verse {
  return {
    usfm: 'PSA.23.1',
    versionId: 3034,
    reference: 'Psalm 23:1',
    fetchedText: 'The LORD is my shepherd; I shall not want.',
    attribution: 'Berean Standard Bible (BSB). Public domain.',
    ...overrides,
  };
}

/**
 * The state the *real* deriver produces for a given history and schedule.
 *
 * `anchorForToday` is only ever called with a `TodayState` that
 * `deriveTodayState` produced, so the tests below feed it one rather than
 * constructing states by hand. A hand-built `{ kind: 'open' }` alongside a
 * history array containing today's devotional is a combination the app
 * cannot produce, and testing against it would prove nothing about the
 * pair (rule 1, applied to a state machine rather than to a payload).
 */
function stateFor(
  devotionals: readonly DevotionalCard[],
  events: readonly UpcomingCalendarEvent[] = [],
): TodayState {
  return deriveTodayState({ devotionals, events, now: NOW, zone: CHICAGO });
}

describe('anchorForToday', () => {
  it('claims today’s passage as today’s when today’s devotional is ready', () => {
    const today = card({ id: 'today-1' });
    expect(anchorForToday(stateFor([today]), [today])).toEqual({
      devotionalId: 'today-1',
      provenance: 'today',
    });
  });

  it('still claims it as today’s after the session is completed', () => {
    // "Open it again" is a normal thing to want, and the passage does not
    // stop being today's because the user finished reading it.
    const today = card({ id: 'today-1', completedAt: '2026-07-20T13:00:00Z' });
    expect(anchorForToday(stateFor([today]), [today])).toEqual({
      devotionalId: 'today-1',
      provenance: 'today',
    });
  });

  it('labels the passage as recent when nothing has been written for today', () => {
    // The bug this pins: the emptiest card in the product showing last
    // week's verse with no indication that it is last week's. The id must
    // be the previous devotional's AND the provenance must say so —
    // asserting only the id would pass against the broken version.
    const yesterday = card({ id: 'yesterday-1', date: '2026-07-19' });
    const state = stateFor([yesterday]);
    expect(state.kind).toBe('open');
    expect(anchorForToday(state, [yesterday])).toEqual({
      devotionalId: 'yesterday-1',
      provenance: 'recent',
    });
  });

  it('labels it recent on a day Wellspring has booked but not yet written', () => {
    const yesterday = card({ id: 'yesterday-1', date: '2026-07-19' });
    const state = stateFor([yesterday], [event()]);
    expect(state.kind).toBe('scheduled');
    expect(anchorForToday(state, [yesterday])?.provenance).toBe('recent');
  });

  it('takes the newest devotional, not the first one it is handed', () => {
    // `GET /v1/devotionals` is newest-first, and "the last devotional
    // Wellspring wrote for you" has to mean the newest one. An implementation
    // that scanned for any non-today row would pass a single-row test.
    const newest = card({ id: 'newest', date: '2026-07-19' });
    const older = card({ id: 'older', date: '2026-07-12' });
    expect(anchorForToday(stateFor([newest, older]), [newest, older])?.devotionalId).toBe('newest');
  });

  it('shows no Scripture at all to a user who has never had a devotional', () => {
    // Absence, not a stand-in. The repo contains real Scripture in
    // `fixtures/snapshots`, and rendering one of those would produce the
    // always-the-same ornamental verse #261 explicitly says is worse than
    // none. See `lib/scripture.ts`.
    expect(anchorForToday(stateFor([]), [])).toBeNull();
  });

  it('shows no Scripture on a first run even when a devotional is scheduled', () => {
    expect(anchorForToday(stateFor([], [event()]), [])).toBeNull();
  });
});

describe('primaryVerse', () => {
  it('takes the devotional’s first passage', () => {
    const first = verse({ usfm: 'PSA.23.1' });
    const second = verse({ usfm: 'ROM.8.28', reference: 'Romans 8:28' });
    expect(primaryVerse([first, second])).toBe(first);
  });

  it('returns null rather than an undefined verse for an empty array', () => {
    // Unreachable for generated output (`DevotionalOutputSchema` requires
    // at least one verse) but the read path returns a stored row, and
    // `undefined.fetchedText` is a worse failure than no verse.
    expect(primaryVerse([])).toBeNull();
  });
});
