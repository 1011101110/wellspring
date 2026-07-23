/**
 * Calendar connection state for the dashboard card (L10, issue #246).
 *
 * ## The whole point: this is a function of the server's rows
 *
 * `deriveConnectionState` takes the parsed `GET /v1/connections` payload
 * and nothing else. It has no access to local storage, to a React state
 * flag, or to "did the user just click connect" — because #213 was exactly
 * that: a disconnect button that reported success from device-local memory
 * while the backend went on reading the user's calendar. The user was told
 * one thing and the truth was another, and no test caught it because the
 * local state was self-consistent.
 *
 * Making the derivation a pure function of the server payload means the
 * card cannot display a state the server did not report. There is no
 * parameter through which a local guess could enter.
 */
import type { Connection, ConnectionsResponse } from '@kairos/shared-contracts';
import type { CardState } from './cardState';
import type { SchedulingCapability } from './upcoming';

/**
 * #246 asks for four distinguishable states, and the fourth is subtle:
 * "revoked" and "never connected" must read as different sentences,
 * because "reconnect" and "connect" are different requests of the user.
 */
export type ConnectionState =
  /** No row at all — the user skipped connect during onboarding, or never started. */
  | { kind: 'never' }
  | { kind: 'active'; connection: Connection }
  /** The row exists and the connection was revoked — by us, by the user, or by Google. */
  | { kind: 'revoked'; connection: Connection }
  /**
   * A row with a status this client does not recognize. Rendered as
   * "needs attention" rather than as working: an unknown status is not
   * evidence of health, and treating it as such is how a broken
   * connection stays invisible.
   */
  | { kind: 'unknown'; connection: Connection };

/** The only provider the web client can start a connection for today. */
/**
 * Must match the API's `connection_provider` enum exactly. It is
 * `google_calendar`, not `google` — the latter silently filtered every
 * connection out and made the card claim nothing was connected.
 */
export const GOOGLE_PROVIDER = 'google_calendar';

export function deriveConnectionState(payload: ConnectionsResponse): ConnectionState {
  const rows = payload.connections.filter((c) => c.provider === GOOGLE_PROVIDER);
  if (rows.length === 0) return { kind: 'never' };

  // An active row wins over a stale revoked one: reconnecting writes a new
  // row rather than mutating the old, so a user who connected, revoked and
  // reconnected holds both. The live one is the answer.
  const active = rows.find((c) => c.status === 'active');
  if (active) return { kind: 'active', connection: active };

  const revoked = rows.find((c) => c.status === 'revoked');
  if (revoked) return { kind: 'revoked', connection: revoked };

  // `rows[0]` is safe — `rows.length === 0` returned above.
  return { kind: 'unknown', connection: rows[0]! };
}

/**
 * Whether other cards may speak as though Wellspring can book something
 * (N1, issue #260).
 *
 * Takes the connection card's whole `CardState` rather than a resolved
 * `ConnectionState`, because the two states that are easiest to get wrong
 * are `loading` and `error` — and both must yield `unknown`. A caller
 * handed only the resolved value has no way to represent "the fetch has
 * not landed", and would have to invent an answer for that render. This
 * signature removes that opportunity.
 *
 * `revoked` maps to `disconnected` and not to `unknown`: a revoked
 * connection is a thing we *do* know, and what we know is that nothing
 * will be booked.
 */
export function schedulingCapability(state: CardState<ConnectionState>): SchedulingCapability {
  if (state.status !== 'ready') return 'unknown';
  switch (state.data.kind) {
    case 'active':
      return 'connected';
    case 'never':
    case 'revoked':
      return 'disconnected';
    case 'unknown':
      // An unrecognized status is not evidence of health — the same
      // refusal the card itself makes above.
      return 'unknown';
  }
}

/**
 * What the Settings → Calendar section should show (#299).
 *
 * ## Two axes, one honest readout
 *
 * Whether Wellspring can read a calendar is the conjunction of two
 * independent facts:
 *
 *  - **Connection** — the OAuth grant, from `GET /v1/connections`
 *    (`ConnectionState` above).
 *  - **Reading consent** — `calendar_enabled` on preferences, the
 *    Foundation §8 gate `calendarFreeBusy` checks.
 *
 * Settings used to render only the *consent* flag under a
 * "Connected"/"Not connected" label. So a user who had connected but whose
 * `calendar_enabled` was false read as "Not connected" and was offered a
 * reconnect — the wrong remedy, since the OAuth grant was fine and only the
 * switch was off (the same distinction #246 draws for the dashboard card,
 * and Foundation §8: revoking a category is not revoking the grant). This
 * collapses the two axes into the three states the section can honestly be
 * in, and it is a pure function so it can be checked without a browser.
 */
export type CalendarSettingsState =
  /** No usable OAuth grant — the remedy is (re)connect, and a reading toggle would control nothing. */
  | { kind: 'not_connected'; action: string }
  /** Connected and reading is on. */
  | { kind: 'reading_on' }
  /** Connected but reading is off — this is the state that had no web switch, #299. */
  | { kind: 'reading_off' };

export function calendarSettingsState(
  connection: ConnectionState | null,
  readingEnabled: boolean,
): CalendarSettingsState {
  // Only an *active* grant makes a reading toggle meaningful. `never`,
  // `revoked`, `unknown`, and an absent/failed fetch (`null`) all resolve to
  // "(re)connect first" — a switch over a calendar we cannot read is a
  // control that does nothing (docs/05 P7). The button label comes from the
  // same `connectionActionLabel` the dashboard card uses, so the two never
  // disagree about "connect" vs "reconnect".
  if (!connection || connection.kind !== 'active') {
    return {
      kind: 'not_connected',
      action: connection
        ? (connectionActionLabel(connection) ?? 'Connect Google Calendar')
        : 'Connect Google Calendar',
    };
  }
  return readingEnabled ? { kind: 'reading_on' } : { kind: 'reading_off' };
}

/**
 * Card copy per state. Each is a complete sentence about what is true,
 * and the two "not working" states are worded differently on purpose.
 */
export const CONNECTION_COPY: Record<ConnectionState['kind'], { title: string; body: string }> = {
  never: {
    title: 'No calendar connected',
    body: 'Wellspring finds your open moments by reading when you are free — never what your meetings are called. Connect a calendar and it can start booking them.',
  },
  active: {
    title: 'Google Calendar connected',
    body: 'Wellspring is reading your free/busy times and booking devotionals in the gaps.',
  },
  revoked: {
    title: 'Google Calendar disconnected',
    body: 'Access to your calendar has been revoked, so Wellspring cannot book new devotionals. Reconnecting restores it.',
  },
  unknown: {
    title: 'Google Calendar needs attention',
    body: 'Wellspring cannot confirm your calendar connection is working. Reconnecting is the quickest way to be sure.',
  },
};

/**
 * The label on the card's one action, or `null` when there is nothing to do.
 *
 * `null` for `active` is load-bearing: #246 puts disconnect in settings,
 * behind the confirmation flow #213 added, and explicitly not here. A
 * connected user therefore has no button on this card at all — which is
 * correct, and is also why this returns `null` rather than a disabled
 * label (docs/05 P7: a control that does nothing does not ship).
 */
export function connectionActionLabel(state: ConnectionState): string | null {
  switch (state.kind) {
    case 'never':
      return 'Connect Google Calendar';
    case 'revoked':
    case 'unknown':
      return 'Reconnect Google Calendar';
    case 'active':
      return null;
  }
}
