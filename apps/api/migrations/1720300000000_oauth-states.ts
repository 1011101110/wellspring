import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * `oauth_states` — server-side store for the OAuth `state` parameter used by
 * the Google Calendar connect flow (issue #22, apps/api/src/routes/connect.ts).
 *
 * Originally the state parameter was a self-contained signed JWT (jose,
 * HS256) carrying { userId, nonce } directly in the URL, verified statelessly
 * on callback. In practice, real end-to-end testing against Google's
 * production OAuth consent screen showed the `state` value arriving back at
 * our callback truncated to just the JWT's recognizable header prefix
 * (`eyJhbGci...`) — Google's own intermediate consent-continue redirect
 * carried the full value intact, so the truncation happens specifically on
 * the final hop back to us, outside anything we can inspect or control.
 *
 * Switching to a short opaque random token (32 bytes hex) with the actual
 * claims stored server-side avoids depending on a long, structured,
 * recognizably-JWT-shaped string surviving an arbitrary number of redirect
 * hops across an OAuth provider we don't control — and is the more
 * conventional OAuth `state` design regardless of that specific bug.
 *
 * Single-use: `consumed_at` is set the moment a state is exchanged in the
 * callback; a second attempt with the same token is rejected. Rows are not
 * kept once consumed or expired — this table is a short-lived handoff, not
 * a historical record.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('oauth_states', {
    token: { type: 'text', primaryKey: true },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    nonce: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('oauth_states', 'expires_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('oauth_states');
}
