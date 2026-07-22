import type { ConnectionsRepository } from '../../db/repositories/connectionsRepository.js';
import type { VerifiedUserId } from '../../db/repositories/types.js';
import type { GoogleKmsService } from './googleKmsService.js';
import type { GoogleOAuthService } from './googleOAuthService.js';

export interface RevokeGoogleConnectionDeps {
  connections: ConnectionsRepository;
  kmsService: GoogleKmsService;
  oauthService: GoogleOAuthService;
}

/** Minimal logger shape — satisfied by both Fastify's `request.log` and a no-op default. */
export interface RevokeLogger {
  warn(obj: unknown, msg: string): void;
}

const NOOP_LOGGER: RevokeLogger = { warn: () => {} };

/**
 * Best-effort: revokes the user's Google refresh token with Google itself
 * (docs/04_DATA_PRIVACY_SECURITY.md §2: "hard-deletes all rows ... and
 * revokes Google tokens"), then marks the connection revoked locally. A
 * no-op if there is no active `google_calendar` connection.
 *
 * Deliberately swallows a revoke failure (network error, or the token
 * already being invalid at Google's end) rather than throwing — both call
 * sites (account deletion, explicit disconnect) must still mark/delete the
 * connection locally even if Google's endpoint can't be reached; the user
 * asked to disconnect/delete, and our own copy of the token must stop being
 * usable regardless of whether Google's side could be confirmed.
 *
 * ---------------------------------------------------------------------------
 * DECISION (issue #213): this does NOT delete already-scheduled future Wellspring
 * events from the user's calendar. Deliberate, not an oversight.
 *
 * The question is real. A user who disconnects and still sees a Wellspring
 * devotional on their calendar will reasonably conclude the disconnect
 * didn't work — which is the exact misreading #213 exists to eliminate.
 *
 * Why not do it here anyway:
 *
 * 1. Ordering makes it a different operation, not an extra line. Deleting
 *    events needs `calendar.events.delete`, i.e. the very access being
 *    revoked, so cleanup would have to run BEFORE `revokeToken` — and a
 *    cleanup failure must never block the revoke, since revocation is what
 *    the user actually asked for. That is a two-phase operation with its own
 *    partial-failure semantics (revoked, some events left behind), not a
 *    refactor of the four statements below.
 *
 * 2. The dependency surface is a feature's worth. This function currently
 *    takes three deps; cleanup adds `CalendarEventsRepository` (which has no
 *    "future events for user" query — `listForUser` is unbounded) and a
 *    per-user `GoogleCalendarClient` built via `withRefreshToken`, threaded
 *    through both call sites: the DELETE route in routes/connect.ts and the
 *    account-deletion path.
 *
 * 3. The residual is bounded and now disclosed. `schedulingWindow.ts` builds
 *    a same-day window, so the daily run inserts events for today, not for
 *    next week — in practice at most one already-inserted event survives a
 *    disconnect, not a calendar full of them. The iOS Data & Privacy footer
 *    now says so in plain language ("Any devotional event already on your
 *    calendar stays there — you can delete it yourself") rather than leaving
 *    the user to infer the wrong thing from a leftover event.
 *
 * RESOLVED (issue #217) — the Meet-bot half of the sharp edge this comment
 * used to describe. The H1c dispatch (#131) is enqueued as a Cloud Task at
 * generation time keyed to `gap_start_at`, and used to be ungated, so a
 * user who disconnected in the morning could still have a Wellspring bot join
 * that afternoon. That is now closed at the point of action rather than
 * here: `/internal/dispatch-meetbot` re-checks user existence and
 * `google_calendar` status before creating any bot (see
 * services/meetBot/meetBotConsentGate.ts).
 *
 * Deliberately NOT closed by cancelling the Cloud Task from this function,
 * for three reasons:
 *
 * 1. It cannot be the primary control anyway. Deleting a queued task races
 *    a task that is already executing; the fire-time check runs inside the
 *    executing request, after this revoke has committed, so it cannot be
 *    outrun. Adding deletion here would buy a nice-to-have on top of a
 *    guarantee we already have.
 * 2. It does not survive the next enqueue site. A future code path that
 *    schedules a dispatch inherits the fire-time gate for free; it does not
 *    inherit a cleanup step somebody remembered to write in this file.
 * 3. It is not a small addition. `TaskScheduler` has no delete method,
 *    `CalendarEventsRepository` has no "future events for this user" query
 *    (`listForUser` is unbounded — same finding as #213 point 2), and both
 *    would have to be threaded through both call sites, for a strictly
 *    redundant effect. That is a feature's worth of surface for no change
 *    in the guarantee.
 *
 * Still open, for whoever picks up the follow-up: deleting already-inserted
 * future Wellspring events (points 1-3 above this block), which account
 * deletion needs identically. `/meetbot/audio/:token/:devotionalId` is also
 * ungated and reachable by a third party on its own schedule — see
 * docs/04_DATA_PRIVACY_SECURITY.md §5.5 for the full audit of deferred work
 * that outlives consent, including two gaps this change does not close.
 * ---------------------------------------------------------------------------
 */
export async function revokeGoogleConnection(
  deps: RevokeGoogleConnectionDeps,
  userId: VerifiedUserId,
  log: RevokeLogger = NOOP_LOGGER,
): Promise<void> {
  const connection = await deps.connections.findByProvider(userId, 'google_calendar');
  if (!connection || connection.status !== 'active') {
    return;
  }

  try {
    const refreshToken = await deps.kmsService.decryptToken(connection.encrypted_refresh_token);
    await deps.oauthService.revokeToken(refreshToken);
  } catch (err) {
    log.warn({ err }, 'Google token revoke failed — proceeding to mark the connection revoked locally anyway');
  }

  await deps.connections.revoke(userId, 'google_calendar');
}
