import type { Queryable, VerifiedUserId } from './types.js';

export interface SessionRow {
  token: string;
  devotional_id: string;
  user_id: string;
  expires_at: Date;
  joined_at: Date | null;
  completed_at: Date | null;
  duration_listened_sec: number | null;
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
    await this.db.query(
      `UPDATE sessions SET expires_at = $3 WHERE user_id = $1 AND token = $2`,
      [userId, token, expiresAt],
    );
  }

  /** Retention: sessions rows purged 7 days after expiry (Privacy §retention). */
  async purgeExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db.query(`DELETE FROM sessions WHERE expires_at < $1`, [cutoff]);
    return result.rowCount ?? 0;
  }
}
