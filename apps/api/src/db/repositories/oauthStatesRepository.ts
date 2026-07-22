import type { Queryable, VerifiedUserId } from './types.js';

export interface OAuthStateRow {
  token: string;
  user_id: string;
  nonce: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

/**
 * Server-side store for the OAuth `state` parameter (apps/api/src/routes/connect.ts).
 *
 * `state` is an opaque random token rather than a self-contained JWT — see
 * migrations/1720300000000_oauth-states.ts for why. `consume` is the only
 * read path and it atomically claims the row (single-use, expiry-checked)
 * so a replayed callback with the same token is rejected even if it arrives
 * within the TTL.
 */
export class OAuthStatesRepository {
  constructor(private readonly db: Queryable) {}

  async create(token: string, userId: VerifiedUserId, nonce: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_states (token, user_id, nonce, expires_at) VALUES ($1, $2, $3, $4)`,
      [token, userId, nonce, expiresAt],
    );
  }

  /**
   * Atomically claims a state token: returns the row's user_id if it exists,
   * is unexpired, and has not already been consumed — and marks it consumed
   * in the same statement. Returns null otherwise (unknown, expired, or
   * replayed token — all treated identically by the caller).
   */
  async consume(token: string): Promise<{ userId: string } | null> {
    const result = await this.db.query<{ user_id: string }>(
      `UPDATE oauth_states
       SET consumed_at = now()
       WHERE token = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [token],
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id } : null;
  }
}
