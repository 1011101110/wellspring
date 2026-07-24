/**
 * YouVersion connection state for the Settings "Connected accounts" card
 * (U5, kairos-devotional#358).
 *
 * ## A pure function of the server's status object
 *
 * Like `deriveConnectionState` for the calendar (#246), this reads only what
 * the server reported and nothing else. The source is the `youversionConnection`
 * field on `GET /v1/preferences` — a CLOSED (`.strict()`) shape carrying only
 * `{ connected, displayName? }` (Foundation §9: nothing about what the user
 * reads or has highlighted may ride there). Making the card a function of that
 * object means it cannot display a state the server did not report.
 *
 * The `unsupported` state is the #244 rule: an older server that does not
 * report `youversionConnection` at all (the field is `.optional()`) yields
 * `unsupported`, and the card renders NOTHING — not a placeholder control that
 * cannot work.
 */
import type { YouVersionConnection } from '@kairos/shared-contracts';

export type YouVersionSettingsState =
  /** The server did not report a `youversionConnection` — render nothing (#244). */
  | { kind: 'unsupported' }
  /** No YouVersion account is connected — offer "Sign in with YouVersion". */
  | { kind: 'not_connected' }
  /** Connected; `displayName` is the §9-safe identity to show, or null when unknown. */
  | { kind: 'connected'; displayName: string | null };

export function youVersionSettingsState(
  connection: YouVersionConnection | undefined,
): YouVersionSettingsState {
  if (!connection) return { kind: 'unsupported' };
  if (!connection.connected) return { kind: 'not_connected' };
  // `displayName` is optional even when connected (the API stores the
  // connection even if the best-effort profile fetch failed — see
  // youversionConnect.ts), so absence is a real, expected case.
  return { kind: 'connected', displayName: connection.displayName ?? null };
}

/**
 * The line shown for a connected account: the account's display name when we
 * have one, and a plain "Connected" when we do not — never a blank or a raw
 * id. Mirrors the voice picker's "never a bare id" rule (#302).
 */
export function youVersionConnectedLabel(displayName: string | null): string {
  return displayName ? `Connected as ${displayName}` : 'Connected';
}
