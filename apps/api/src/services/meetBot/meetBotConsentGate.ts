/**
 * Fire-time consent gate for the H1c Meet-bot dispatch (#217, epic #186).
 *
 * The defect this closes
 * ----------------------
 * The Meet-bot dispatch is enqueued as a Cloud Task at *generation* time
 * (generateNowOrchestrator.ts, `taskName: meetbot-<devotionalId>`), keyed
 * to `gap_start_at`, and until #217 nothing re-checked consent when that
 * task actually fired. The queue is live (created 2026-07-07, wired into
 * deploy 2026-07-08 — see index.ts), so this was a real production gap,
 * not a theoretical one:
 *
 *   - A user who disconnects their calendar in the morning could still
 *     have a Wellspring bot join their meeting that afternoon and speak aloud.
 *   - A user who *deleted their account* had the identical gap: the task
 *     was already in the queue and nothing dequeued it.
 *
 * docs/04_DATA_PRIVACY_SECURITY.md §2 promises deletion hard-deletes the
 * user's rows and revokes their Google tokens. Neither of those reaches
 * into a Cloud Tasks queue. A stale calendar entry left behind by a
 * disconnect (#213) is passive residue the user can delete; a bot joining
 * a meeting is an *active action taken on their behalf after they revoked
 * consent*. For a product whose whole posture is consent-first
 * (docs/00_FOUNDATION.md §8), that is the wrong kind of surprise, and the
 * bounded-blast-radius argument that made #213's disclosure-only fix
 * acceptable does not transfer.
 *
 * Why gate at fire time rather than only dequeue on revoke
 * --------------------------------------------------------
 * Fire-time gating is the robust fix, and it is deliberately the PRIMARY
 * one (#217 work item 1):
 *
 *   - It closes disconnect AND account deletion in a single place.
 *   - It survives any future code path that enqueues a dispatch task —
 *     a new enqueue site inherits the gate for free, whereas a new
 *     enqueue site does not inherit a cleanup step somebody remembered to
 *     write in `revokeGoogleConnection`.
 *   - It is not racy. Deleting the queued task (#217 work item 2) races
 *     against a task that is already executing; this check runs inside
 *     the executing request, after the revoke has committed, so there is
 *     no window in which it can be outrun.
 *
 * Fail-closed by construction
 * ---------------------------
 * Every path through `checkMeetBotConsent` that does not positively
 * observe (a) a live devotional row, (b) a live user row, and (c) an
 * `active` `google_calendar` connection returns a refusal. Unknown state
 * is refusal, never "proceed" — the cost asymmetry is stark: refusing
 * wrongly means one devotional is delivered without a bot (the user still
 * has the calendar event and the plain-audio session link); proceeding
 * wrongly means a bot joins a stranger's meeting and talks. A genuinely
 * *transient* failure (the database being unreachable) is deliberately
 * NOT modelled as a refusal — it throws, so the caller can distinguish
 * "we know the answer is no" from "we could not find out" and pick the
 * right HTTP status for each (see routes/internal.ts).
 */
import type { ConnectionsRepository } from '../../db/repositories/connectionsRepository.js';
import type { DevotionalsRepository } from '../../db/repositories/devotionalsRepository.js';
import type { UsersRepository } from '../../db/repositories/usersRepository.js';
import { asVerifiedUserId } from '../../db/repositories/types.js';

/**
 * Narrow structural deps — only the three methods the gate calls, not the
 * whole repositories. Keeps the unit tests honest (a fake cannot
 * accidentally satisfy the gate through some unrelated method) and makes
 * the gate's data access auditable at a glance: it reads an owner id, a
 * user row, and a connection row, and nothing else.
 */
export interface MeetBotConsentGateDeps {
  devotionals: Pick<DevotionalsRepository, 'findOwnerUserId'>;
  users: Pick<UsersRepository, 'findById'>;
  connections: Pick<ConnectionsRepository, 'findByProvider'>;
}

/**
 * Why a refusal happened. Logged (routes/internal.ts) so a refusal is
 * auditable after the fact — "the bot did not join, and here is which
 * consent signal said no" — without logging anything sensitive: these are
 * fixed enum values, and the only identifiers that accompany them are
 * opaque internal ids (never the meeting URL, never an email).
 */
export type MeetBotRefusalReason =
  /**
   * No devotional row with that id. Overwhelmingly the account-deletion
   * case: `users.hardDelete` cascades to `devotionals`, so a deleted
   * account's queued task arrives pointing at a row that no longer
   * exists. Also covers a devotional purged by retention (purgeJobs.ts).
   * Either way there is no one left to consent, so: refuse.
   */
  | 'devotional_not_found'
  /**
   * The devotional row resolved to a user id with no `users` row. Should
   * be unreachable given the FK, but "should be unreachable" is not a
   * reason to dispatch a bot — this is the fail-closed default made
   * explicit rather than left to fall through.
   */
  | 'user_not_found'
  /**
   * The user never had (or no longer has) a `google_calendar` connection
   * row at all. `revokeGoogleConnection` marks rather than deletes, so
   * this is mostly the never-connected case — but a missing row is
   * absence of consent just as much as a revoked one.
   */
  | 'connection_missing'
  /**
   * The connection row exists but its status is not `active` — the
   * explicit-disconnect case. `ConnectionsRepository.revoke` sets
   * `status = 'revoked'`; this compares against `'active'` positively
   * rather than testing `!== 'revoked'`, so any future status value
   * (e.g. a `'suspended'`) fails closed instead of silently permitting.
   */
  | 'connection_revoked';

export type MeetBotConsentDecision =
  | { allowed: true; userId: string }
  | { allowed: false; reason: MeetBotRefusalReason; userId?: string };

/**
 * Decides whether a Meet-bot may be created for `devotionalId` right now.
 *
 * Resolves the owner from the devotional id server-side rather than
 * trusting a userId in the task body — see
 * `DevotionalsRepository.findOwnerUserId` for why that distinction
 * matters (Foundation §10: identity never comes from the request body).
 *
 * Throws only on genuine infrastructure failure (the repository calls
 * rejecting). It never converts such a failure into `allowed: true`.
 */
export async function checkMeetBotConsent(
  deps: MeetBotConsentGateDeps,
  devotionalId: string,
): Promise<MeetBotConsentDecision> {
  const ownerUserId = await deps.devotionals.findOwnerUserId(devotionalId);
  if (!ownerUserId) {
    return { allowed: false, reason: 'devotional_not_found' };
  }

  // `asVerifiedUserId` is the repository layer's choke point (types.ts).
  // Using it here is legitimate rather than a laundering of untrusted
  // input: `ownerUserId` came out of our own database as the authoritative
  // owner of this row, not off the wire.
  const userId = asVerifiedUserId(ownerUserId);

  // Checked even though the devotional row's FK implies the user exists.
  // The two reads are not atomic — a deletion committing between them is
  // exactly the race #217 is about — and this ordering is the safe one:
  // if the user is deleted after this check, the bot is already the lesser
  // problem, whereas skipping the check to save a query would mean trusting
  // a stale FK inference at the moment we are deciding to act on someone's
  // behalf.
  const user = await deps.users.findById(userId);
  if (!user) {
    return { allowed: false, reason: 'user_not_found', userId: ownerUserId };
  }

  const connection = await deps.connections.findByProvider(userId, 'google_calendar');
  if (!connection) {
    return { allowed: false, reason: 'connection_missing', userId: ownerUserId };
  }
  if (connection.status !== 'active') {
    return { allowed: false, reason: 'connection_revoked', userId: ownerUserId };
  }

  return { allowed: true, userId: ownerUserId };
}
