/**
 * `GET /v1/connections` (L10, issue #246) — calendar connection state.
 *
 * ## Why this schema exists at all
 *
 * The route predates the contracts package and returns its object literal
 * directly (`apps/api/src/routes/connect.ts`). It is described here rather
 * than left untyped because #246 makes this endpoint *structurally*
 * load-bearing: the dashboard's connection card must read the server's row
 * and never client-local state. That was #213's root cause — an iOS
 * disconnect button that reported success from device memory while the
 * backend kept reading the user's calendar. A client that parses this
 * schema cannot fall back to a local guess, because there is nothing local
 * to fall back to.
 *
 * ## The envelope is `connections`, not `data`
 *
 * Every other `/v1` route answers `{ ok, data }`. This one answers
 * `{ ok, connections }`. That is the existing wire format and changing it
 * would break shipped iOS builds, so the schema matches the server rather
 * than the convention. Noted here because it is exactly the kind of
 * inconsistency a client author assumes away and then debugs for an hour.
 */
import { z } from 'zod';

/**
 * `status` is a plain `text` column with no DB constraint, written as
 * `'active'` on connect and `'revoked'` on disconnect
 * (`connectionsRepository.ts`). It is deliberately NOT an enum here.
 *
 * #246 asks for four distinguishable card states — never-connected,
 * active, revoked, error — but only two of them are values this column
 * currently produces; "never connected" is the *absence* of a row, and no
 * writer sets `'error'` today. Modelling this as `z.enum(['active',
 * 'revoked'])` would reject an unknown status outright and blank the card,
 * which is the worst available answer for a user whose calendar is in a
 * state we did not anticipate. A client should treat an unrecognized
 * status as "something is wrong, offer reconnect" rather than as "fine".
 */
export const ConnectionSchema = z.object({
  /**
   * The provider key, exactly as the API emits it and the `connection_provider`
   * Postgres enum stores it. A literal, NOT `z.string()`.
   *
   * This was `z.string()`, and it cost a user-visible bug: the web client
   * filtered for `'google'` while the API has always returned
   * `'google_calendar'`. Every connection was filtered out, so the card
   * rendered its "no calendar connected" state — which is indistinguishable
   * from the genuine empty state — while the connection sat active in the
   * database the whole time. The user reconnected repeatedly, and every
   * reconnect worked and changed nothing on screen.
   *
   * A loose `z.string()` could not catch it at compile time or parse time.
   * Typing it as the closed set the DB actually holds makes the next such
   * mismatch a build failure rather than a silent lie on a card.
   */
  provider: z.enum(['google_calendar']),
  /** Mirrors the `connections_status_check` constraint. */
  status: z.enum(['active', 'revoked', 'error']),
  /** ISO-8601, or `null` for a row that never completed a connection. */
  connectedAt: z.string().nullable(),
  scopes: z.array(z.string()).nullable(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionsResponseSchema = z.object({
  ok: z.literal(true),
  connections: z.array(ConnectionSchema),
});
export type ConnectionsResponse = z.infer<typeof ConnectionsResponseSchema>;
