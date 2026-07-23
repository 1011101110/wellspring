/**
 * #246's acceptance: "Card state matches the `connections` row in all four
 * states (never-connected / active / revoked / error) — seeded-state
 * tests." These are those seeded states.
 */
import { describe, expect, it } from 'vitest';
import type { Connection, ConnectionsResponse } from '@kairos/shared-contracts';
import {
  calendarSettingsState,
  CONNECTION_COPY,
  connectionActionLabel,
  deriveConnectionState,
  GOOGLE_PROVIDER,
  schedulingCapability,
  type ConnectionState,
} from '../src/lib/connectionState';
import { emptyCard, errorCard, loadingCard, readyCard } from '../src/lib/cardState';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    provider: 'google_calendar',
    status: 'active',
    connectedAt: '2026-06-01T10:00:00Z',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    ...overrides,
  };
}

function payload(connections: Connection[]): ConnectionsResponse {
  return { ok: true, connections };
}

describe('deriveConnectionState', () => {
  it('reports never-connected when the user has no row', () => {
    expect(deriveConnectionState(payload([])).kind).toBe('never');
  });

  it('reports active for a live connection', () => {
    expect(deriveConnectionState(payload([connection()])).kind).toBe('active');
  });

  it('reports revoked distinctly from never-connected', () => {
    const state = deriveConnectionState(payload([connection({ status: 'revoked' })]));
    expect(state.kind).toBe('revoked');
    // The two must not read as the same sentence: "connect" and
    // "reconnect" are different requests of the user.
    expect(CONNECTION_COPY.revoked.title).not.toBe(CONNECTION_COPY.never.title);
    expect(CONNECTION_COPY.revoked.body).not.toBe(CONNECTION_COPY.never.body);
  });

  it('treats an unrecognized status as needing attention, never as healthy', () => {
    // An unknown status is not evidence of health. Rendering it as
    // connected is how a broken calendar stays invisible.
    const state = deriveConnectionState(payload([connection({ status: 'error' })]));
    expect(state.kind).toBe('unknown');
    expect(CONNECTION_COPY.unknown.title).not.toBe(CONNECTION_COPY.active.title);
  });

  it('prefers a live row over a stale revoked one', () => {
    // Reconnecting writes a new row rather than mutating the old, so a
    // reconnected user holds both.
    const state = deriveConnectionState(
      payload([connection({ status: 'revoked' }), connection({ status: 'active' })]),
    );
    expect(state.kind).toBe('active');
  });

  it('ignores providers the web client cannot act on', () => {
    // Cast deliberately: since the provider mismatch bug, `provider` is a
    // closed literal matching the `connection_provider` DB enum, which has
    // exactly one member. No second provider is *constructible* through the
    // type today — Microsoft is #191 and unbuilt. The cast keeps the filter's
    // defensiveness under test without weakening the type that now prevents
    // the original bug.
    const state = deriveConnectionState(
      payload([{ ...connection({}), provider: 'microsoft' as never }]),
    );
    expect(state.kind).toBe('never');
  });

  it('matches the provider value the API actually emits, not a plausible-looking one', () => {
    // The regression test for the bug itself. The client filtered for
    // 'google' while the API has always returned 'google_calendar', so every
    // connection was discarded and the card showed "no calendar connected"
    // while an active row sat in the database. The old test fixture also said
    // 'google', so the suite agreed with the bug instead of catching it.
    //
    // Asserted against the constant AND the literal, so renaming the constant
    // cannot quietly re-introduce a mismatch.
    expect(GOOGLE_PROVIDER).toBe('google_calendar');
    const state = deriveConnectionState(
      payload([{ ...connection({}), provider: 'google_calendar', status: 'active' }]),
    );
    expect(state.kind).toBe('active');
  });
});

describe('connectionActionLabel', () => {
  it('offers connect to a user who never connected — the skipped-onboarding re-entry', () => {
    expect(connectionActionLabel({ kind: 'never' })).toMatch(/^Connect/);
  });

  it('offers reconnect, not connect, for a revoked connection', () => {
    expect(connectionActionLabel({ kind: 'revoked', connection: connection() })).toMatch(
      /^Reconnect/,
    );
  });

  it('offers no action at all when connected — disconnect lives in settings (#246)', () => {
    // Not a disabled button: docs/05 P7. There is simply nothing here.
    expect(connectionActionLabel({ kind: 'active', connection: connection() })).toBeNull();
  });
});

/*
 * #260. `schedulingCapability` is the gate that stops other cards
 * speaking as though a devotional is coming.
 *
 * Every case below builds its input by running the REAL derivation over a
 * real payload and wrapping it in the REAL card constructors, rather than
 * hand-writing `{ status: 'ready', data: { kind: 'active' } }`. A
 * hand-written state is a second copy of the belief under test — the
 * lesson from #253, where the fixture said `provider: 'google'` because
 * the code did, and 115 tests agreed with the bug.
 */
describe('schedulingCapability', () => {
  it('is connected only when a live row actually exists', () => {
    expect(schedulingCapability(readyCard(deriveConnectionState(payload([connection()]))))).toBe(
      'connected',
    );
  });

  it('is disconnected for a user who never connected', () => {
    const state = deriveConnectionState(payload([]));
    expect(schedulingCapability(readyCard(state))).toBe('disconnected');
  });

  it('is disconnected — not unknown — for a revoked row, because that is a thing we know', () => {
    const state = deriveConnectionState(payload([connection({ status: 'revoked' })]));
    expect(schedulingCapability(readyCard(state))).toBe('disconnected');
  });

  it('is unknown while the card is still loading', () => {
    // The state most likely to be rounded to a certainty by accident.
    expect(schedulingCapability(loadingCard<ConnectionState>())).toBe('unknown');
  });

  it('is unknown when the connection fetch failed', () => {
    // A failed fetch is not evidence that nothing is connected, and it is
    // certainly not evidence that something is (#245).
    expect(schedulingCapability(errorCard<ConnectionState>('boom'))).toBe('unknown');
  });

  it('never reports connected from any state that is not a live row', () => {
    // The property that matters: `connected` is what unlocks a sentence
    // promising a specific day. Nothing but an active row may produce it.
    const notConnected = [
      loadingCard<ConnectionState>(),
      errorCard<ConnectionState>('boom'),
      emptyCard<ConnectionState>(),
      readyCard(deriveConnectionState(payload([]))),
      readyCard(deriveConnectionState(payload([connection({ status: 'revoked' })]))),
    ];
    for (const state of notConnected) {
      expect(schedulingCapability(state)).not.toBe('connected');
    }
  });
});

describe('calendarSettingsState (#299)', () => {
  const active = deriveConnectionState(payload([connection()]));
  const never = deriveConnectionState(payload([]));
  const revoked = deriveConnectionState(payload([connection({ status: 'revoked' })]));

  it('is reading_on when connected and calendar_enabled is true', () => {
    expect(calendarSettingsState(active, true)).toEqual({ kind: 'reading_on' });
  });

  it('is reading_off — the state #299 could not represent — when connected but reading is off', () => {
    // The whole bug: an active OAuth grant with the consent flag false. This
    // must NOT read as "not connected", or the user is sent to reconnect —
    // the wrong remedy — instead of to the toggle.
    expect(calendarSettingsState(active, false)).toEqual({ kind: 'reading_off' });
  });

  it('is not_connected when there is no grant, and offers "Connect"', () => {
    expect(calendarSettingsState(never, false)).toEqual({
      kind: 'not_connected',
      action: 'Connect Google Calendar',
    });
    // Reading consent being true is irrelevant with nothing to read.
    expect(calendarSettingsState(never, true).kind).toBe('not_connected');
  });

  it('offers "Reconnect" for a revoked grant, matching the dashboard card', () => {
    const state = calendarSettingsState(revoked, true);
    expect(state.kind).toBe('not_connected');
    expect(state).toEqual({ kind: 'not_connected', action: 'Reconnect Google Calendar' });
  });

  it('treats an unknown (unfetched/failed) connection as not connected rather than guessing', () => {
    // `null` is "we could not read it", which is not evidence of a grant —
    // the same refusal-to-guess the scheduling capability makes.
    expect(calendarSettingsState(null, true).kind).toBe('not_connected');
  });
});
