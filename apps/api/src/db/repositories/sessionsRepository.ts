import type { OpenMomentStoredResponse } from '@kairos/shared-contracts';
import type { Queryable, VerifiedUserId } from './types.js';

/**
 * One calendar-scheduled standard-slot devotional and whether its session
 * was ever engaged with — the row shape behind the P4 attendance read
 * model (`services/rhythm/attendanceSignals.ts`, issue #323).
 *
 * This type never leaves the server process. It IS per-event history —
 * exactly what Foundation §9 forbids on any API surface — which is why
 * `AttendanceSignals` (the only exported shape) reduces it to aggregates
 * before anything else sees it.
 */
export interface ScheduledAttendanceRow {
  devotional_id: string;
  /** The calendar event's gap start — when the invitation stood. */
  scheduled_at: Date;
  joined_at: Date | null;
  completed_at: Date | null;
}

export interface SessionRow {
  token: string;
  devotional_id: string;
  user_id: string;
  expires_at: Date;
  joined_at: Date | null;
  completed_at: Date | null;
  duration_listened_sec: number | null;
  /**
   * The stored outcome of the ONE Open Moment response for this session
   * (EPIC V #360), or null when the listener has not (yet) responded. Set
   * once, guarded — see `markOpenMomentResponse`. Never contains the
   * transcript (epic §5). jsonb column, migration 1722800000000.
   */
  open_moment_response: OpenMomentStoredResponse | null;
  created_at: Date;
}

export interface CreateSessionInput {
  devotionalId: string;
  expiresAt: Date;
}

/**
 * Sessions are the one exception to "always scope by verified userId":
 * the join flow (`GET /session/:token`, Architecture §3.2) is an
 * intentionally unauthenticated capability URL (Foundation §10 — "session
 * pages are unguessable and expiring... require no login"). `findByToken`
 * is the ONLY unscoped read method in the whole repository layer, and it
 * exists for exactly that one documented reason — every other method
 * still takes `userId: VerifiedUserId` and scopes by it (e.g. for the
 * authenticated devotional-history / "my sessions" surfaces, and for
 * writes, which always require proving ownership first).
 */
export class SessionsRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: VerifiedUserId, input: CreateSessionInput): Promise<SessionRow> {
    const result = await this.db.query<SessionRow>(
      `INSERT INTO sessions (devotional_id, user_id, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.devotionalId, userId, input.expiresAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error('create: insert returned no row');
    return row;
  }

  /**
   * Unscoped by design (see class doc). Callers (the public session-join
   * route) must still enforce expiry ("identical 404 for unknown vs
   * expired-and-purged", Privacy §enumeration) and must never use the
   * returned `user_id` for anything beyond re-deriving a VerifiedUserId
   * to pass into other repositories for that one request.
   */
  async findByToken(token: string): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(`SELECT * FROM sessions WHERE token = $1`, [
      token,
    ]);
    return result.rows[0] ?? null;
  }

  /**
   * The second — and only other — unscoped read (see class doc for the
   * first). Exists for exactly one caller: the `/internal/dispatch-meetbot`
   * voice-agent mode (Epic Q, #335), which must resolve a devotional's
   * EXISTING session token to build the Stage URL the bot loads. That
   * route is behind INTERNAL_API_TOKEN (never user-facing), receives only
   * a devotionalId, and the token it reads is handed to Attendee as the
   * same capability the session/stage pages already treat it as (docs/04).
   * Read-only by design: if no session row exists the dispatch refuses
   * (`no_session`) — it must NEVER mint a second session for a devotional.
   * Newest row wins on the off-chance a devotional has more than one
   * (the FK is not unique — see listScheduledAttendance's notes).
   */
  async findByDevotionalId(devotionalId: string): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT * FROM sessions WHERE devotional_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [devotionalId],
    );
    return result.rows[0] ?? null;
  }

  async markJoined(userId: VerifiedUserId, token: string): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `UPDATE sessions SET joined_at = now()
       WHERE token = $1 AND user_id = $2 AND joined_at IS NULL
       RETURNING *`,
      [token, userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Records the ONE Open Moment response for this session (EPIC V #360),
   * set-once — the `open_moment_response IS NULL` guard makes a concurrent or
   * retried POST a no-op (returns `null`), exactly like `markJoined`/
   * `markCompleted`. The caller treats a `null` return as "someone else won
   * the race / already responded" and reads the existing row back to return
   * the first result (idempotency, V2 #363). Never stores the transcript.
   */
  async markOpenMomentResponse(
    userId: VerifiedUserId,
    token: string,
    response: OpenMomentStoredResponse,
  ): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `UPDATE sessions SET open_moment_response = $3::jsonb
       WHERE token = $1 AND user_id = $2 AND open_moment_response IS NULL
       RETURNING *`,
      [token, userId, JSON.stringify(response)],
    );
    return result.rows[0] ?? null;
  }

  /**
   * `durationListenedSec` is only ever written on this first, genuine
   * completion — `completed_at IS NULL` in the WHERE clause makes a
   * double-submit a no-op (row already has `completed_at` set, so this
   * returns null and the caller's existing "already completed" path takes
   * over) rather than silently overwriting a real duration with a later,
   * possibly-null resubmission (issue #86).
   */
  async markCompleted(
    userId: VerifiedUserId,
    token: string,
    durationListenedSec: number | null = null,
  ): Promise<SessionRow | null> {
    const result = await this.db.query<SessionRow>(
      `UPDATE sessions SET completed_at = now(), duration_listened_sec = $3
       WHERE token = $1 AND user_id = $2 AND completed_at IS NULL
       RETURNING *`,
      [token, userId, durationListenedSec],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Monthly recap support (docs/14 §5.9, issue #96): "sat with Scripture N
   * times" counts sessions the user actually opened, not merely generated
   * — `joined_at` (issue #84) is exactly that signal. `endExclusive` is the
   * first instant of the following month, so this is a half-open interval
   * (no double-counting at a month boundary).
   */
  async countJoinedInRange(
    userId: VerifiedUserId,
    startInclusive: Date,
    endExclusive: Date,
  ): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions
       WHERE user_id = $1 AND joined_at IS NOT NULL AND joined_at >= $2 AND joined_at < $3`,
      [userId, startInclusive, endExclusive],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * The P4 attendance denominator (issue #323): calendar-scheduled,
   * standard-slot devotionals whose event has already ENDED, newest
   * first, each with the strongest engagement its sessions ever showed.
   *
   * The three exclusions the epic demands are structural here, not
   * post-filtered:
   *
   *  - `d.slot_type = 'standard'` — examen rows never enter (and examen
   *    generation passes `skipCalendar: true` anyway, so they'd also fail
   *    the join).
   *  - The INNER JOIN on `calendar_events` — generate-now (#238 passes
   *    `skipCalendar: true`, userScoped.ts) and distress sessions
   *    (`distressSignalOverride` forces the calendar step off,
   *    generateNowOrchestrator step 6) insert no event row, so a
   *    devotional the user never had a standing invitation to cannot
   *    count against them. Absence of the row IS the exclusion.
   *  - `ce.gap_end_at <= $3` — an event still in the future (or happening
   *    right now) is not yet an unjoined invitation; only finished
   *    windows are judged. `>= $2` makes the trailing-window boundary
   *    inclusive at exactly `windowStart` (day 28 counts).
   *
   * `max()` over a LEFT-joined `sessions`: the FK is not unique, and if
   * ANY session for the devotional was joined/completed, the invitation
   * was met — a join must only ever count FOR the user. LEFT (not inner)
   * because sessions rows are purged 7 days after expiry (Privacy
   * §retention) while this window is 28 days: an old scheduled devotional
   * whose session aged out reads as unjoined here. That bias is accepted
   * and bounded — the trailing `consecutiveUnjoined` run only looks at
   * the newest rows (inside retention), and the decayed score weighs a
   * 28-day-old event at ~0.12 — but it is why `engagedScore` is
   * documented as a smoothed trend, not a precise attendance ratio.
   */
  async listScheduledAttendance(
    userId: VerifiedUserId,
    windowStartInclusive: Date,
    endInclusive: Date,
  ): Promise<ScheduledAttendanceRow[]> {
    const result = await this.db.query<ScheduledAttendanceRow>(
      `SELECT d.id AS devotional_id,
              ce.gap_start_at AS scheduled_at,
              max(s.joined_at) AS joined_at,
              max(s.completed_at) AS completed_at
         FROM devotionals d
         JOIN calendar_events ce
           ON ce.devotional_id = d.id AND ce.user_id = d.user_id
         LEFT JOIN sessions s
           ON s.devotional_id = d.id AND s.user_id = d.user_id
        WHERE d.user_id = $1
          AND d.slot_type = 'standard'
          AND ce.gap_end_at >= $2
          AND ce.gap_end_at <= $3
        GROUP BY d.id, ce.gap_start_at
        ORDER BY ce.gap_start_at DESC`,
      [userId, windowStartInclusive, endInclusive],
    );
    return result.rows;
  }

  /**
   * Most recent join across ALL of this user's sessions — scheduled or
   * not. Deliberately broader than `listScheduledAttendance`: the epic's
   * ramp-up rule is "ANY joined session after a back-off", and a
   * generate-now or distress session may only ever count FOR the user.
   * Someone leaning on "make one now" during a backed-off stretch is
   * re-engaging, and the ladder should climb for them.
   */
  async latestJoinedAt(userId: VerifiedUserId, sinceInclusive: Date): Promise<Date | null> {
    const result = await this.db.query<{ last_joined_at: Date | null }>(
      `SELECT max(joined_at) AS last_joined_at FROM sessions
        WHERE user_id = $1 AND joined_at >= $2`,
      [userId, sinceInclusive],
    );
    return result.rows[0]?.last_joined_at ?? null;
  }

  async listForUser(userId: VerifiedUserId): Promise<SessionRow[]> {
    const result = await this.db.query<SessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Updates the expiry of a session — called after a calendar event is
   * inserted so the expiry is anchored to event-end + 48h (Foundation §10
   * / API spec §8.2) rather than the generate-now placeholder of now + 48h.
   * Scoped by userId to prevent cross-user expiry manipulation.
   */
  async updateExpiry(userId: VerifiedUserId, token: string, expiresAt: Date): Promise<void> {
    await this.db.query(`UPDATE sessions SET expires_at = $3 WHERE user_id = $1 AND token = $2`, [
      userId,
      token,
      expiresAt,
    ]);
  }

  /** Retention: sessions rows purged 7 days after expiry (Privacy §retention). */
  async purgeExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db.query(`DELETE FROM sessions WHERE expires_at < $1`, [cutoff]);
    return result.rowCount ?? 0;
  }
}
