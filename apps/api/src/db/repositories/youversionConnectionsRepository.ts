import type { Queryable, VerifiedUserId } from './types.js';

/**
 * Encrypted YouVersion OAuth token store (U2, kairos-devotional#355). One row
 * per user (PK = user_id). Same at-rest posture as `connections`: this layer
 * only ever holds Cloud-KMS ciphertext, never plaintext tokens — encryption
 * happens in the route BEFORE `upsert` and decryption in the caller AFTER a
 * read, exactly like `ConnectionsRepository` (repositories in this codebase
 * hold no KMS dependency; the crypto boundary lives in the service/route
 * layer). Every method takes `userId: VerifiedUserId` first and scopes
 * `WHERE user_id = $1`.
 */
export interface YouVersionConnectionRow {
  user_id: string;
  access_token_encrypted: Buffer;
  /** NULL when YouVersion issued no refresh token (⚠️ must-confirm U1). */
  refresh_token_encrypted: Buffer | null;
  kms_key_version: string;
  token_expires_at: Date | null;
  youversion_user_id: string | null;
  display_name: string | null;
  scopes: string | null;
  connected_at: Date;
}

export interface UpsertYouVersionConnectionInput {
  /** Already KMS-encrypted ciphertext — this layer never sees plaintext. */
  accessTokenEncrypted: Buffer;
  /** Already-encrypted, or null when the provider issued no refresh token. */
  refreshTokenEncrypted: Buffer | null;
  kmsKeyVersion: string;
  tokenExpiresAt: Date | null;
  youVersionUserId: string | null;
  displayName: string | null;
  scopes: string | null;
}

export class YouVersionConnectionsRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(
    userId: VerifiedUserId,
    input: UpsertYouVersionConnectionInput,
  ): Promise<YouVersionConnectionRow> {
    const result = await this.db.query<YouVersionConnectionRow>(
      `INSERT INTO youversion_connections
         (user_id, access_token_encrypted, refresh_token_encrypted, kms_key_version,
          token_expires_at, youversion_user_id, display_name, scopes, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         kms_key_version = EXCLUDED.kms_key_version,
         token_expires_at = EXCLUDED.token_expires_at,
         youversion_user_id = EXCLUDED.youversion_user_id,
         display_name = EXCLUDED.display_name,
         scopes = EXCLUDED.scopes,
         connected_at = now()
       RETURNING *`,
      [
        userId,
        input.accessTokenEncrypted,
        input.refreshTokenEncrypted,
        input.kmsKeyVersion,
        input.tokenExpiresAt,
        input.youVersionUserId,
        input.displayName,
        input.scopes,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('youversion upsert: insert/update returned no row');
    return row;
  }

  async get(userId: VerifiedUserId): Promise<YouVersionConnectionRow | null> {
    const result = await this.db.query<YouVersionConnectionRow>(
      `SELECT * FROM youversion_connections WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async delete(userId: VerifiedUserId): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM youversion_connections WHERE user_id = $1`,
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
