import type { Queryable, VerifiedUserId } from './types.js';

export type ConnectionProvider = 'google_calendar';

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: ConnectionProvider;
  encrypted_refresh_token: Buffer;
  encryption_iv: Buffer;
  encryption_auth_tag: Buffer;
  kms_key_version: string;
  scopes: string[];
  status: string;
  connected_at: Date;
  revoked_at: Date | null;
}

export interface UpsertConnectionInput {
  provider: ConnectionProvider;
  /** Already AES-256-GCM encrypted ciphertext — this layer never sees plaintext tokens. */
  encryptedRefreshToken: Buffer;
  /**
   * Vestigial (docs/04 §5.2, issue #43): Cloud KMS's symmetric encrypt
   * already performs AES-256-GCM directly (no local envelope layer), so
   * there is no local IV/auth-tag to store. Always an empty buffer today —
   * reserved for a future local envelope layer, not evidence of a missing one.
   */
  encryptionIv: Buffer;
  encryptionAuthTag: Buffer;
  kmsKeyVersion: string;
  scopes: string[];
}

/**
 * Every method takes `userId: VerifiedUserId` first and every query is
 * scoped `WHERE user_id = $1` — this table holds encrypted OAuth tokens,
 * the highest-sensitivity data in the schema (Foundation §10).
 */
export class ConnectionsRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(userId: VerifiedUserId, input: UpsertConnectionInput): Promise<ConnectionRow> {
    const result = await this.db.query<ConnectionRow>(
      `INSERT INTO connections
         (user_id, provider, encrypted_refresh_token, encryption_iv, encryption_auth_tag, kms_key_version, scopes, status, connected_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), NULL)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         encryption_iv = EXCLUDED.encryption_iv,
         encryption_auth_tag = EXCLUDED.encryption_auth_tag,
         kms_key_version = EXCLUDED.kms_key_version,
         scopes = EXCLUDED.scopes,
         status = 'active',
         connected_at = now(),
         revoked_at = NULL
       RETURNING *`,
      [
        userId,
        input.provider,
        input.encryptedRefreshToken,
        input.encryptionIv,
        input.encryptionAuthTag,
        input.kmsKeyVersion,
        input.scopes,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('upsert: insert/update returned no row');
    return row;
  }

  async findByProvider(
    userId: VerifiedUserId,
    provider: ConnectionProvider,
  ): Promise<ConnectionRow | null> {
    const result = await this.db.query<ConnectionRow>(
      `SELECT * FROM connections WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return result.rows[0] ?? null;
  }

  async listForUser(userId: VerifiedUserId): Promise<ConnectionRow[]> {
    const result = await this.db.query<ConnectionRow>(
      `SELECT * FROM connections WHERE user_id = $1 ORDER BY connected_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async revoke(userId: VerifiedUserId, provider: ConnectionProvider): Promise<void> {
    await this.db.query(
      `UPDATE connections SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
  }
}
