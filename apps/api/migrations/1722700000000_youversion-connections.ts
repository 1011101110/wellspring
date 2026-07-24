import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * YouVersion account connection foundation (U2, kairos-devotional#355 /
 * epic #353).
 *
 * Three changes land together, all part of the same OAuth + token-storage
 * foundation that U3/U4/U5 build on:
 *
 * **1. `youversion_connections`** — the encrypted token store, deliberately
 * a SEPARATE table from `connections` (the Google Calendar store) rather
 * than a second `provider` row in it. YouVersion's token shape is genuinely
 * different: it is an OAuth2 authorization-code + PKCE flow that mints BOTH
 * an access token (short-lived, Bearer, used against api.youversion.com) and
 * — if the provider issues one — a refresh token, whereas the Google store
 * keeps only a refresh token and discards the access token after exchange.
 * The columns encode that difference (`access_token_encrypted` NOT NULL,
 * `refresh_token_encrypted` NULLABLE, `token_expires_at`), so folding it into
 * the Google table would have meant nullable columns that are meaningless for
 * one provider and required for the other.
 *
 * Same at-rest posture as `connections` (Foundation §10, docs/04 §5.2): both
 * token columns hold Cloud-KMS ciphertext (`bytea`), never plaintext, and
 * `kms_key_version` records which key version encrypted the row for rotation
 * safety — identical to `connections.kms_key_version`. `user_id` is the PK
 * (1:1 with users, one YouVersion account per Wellspring user) with
 * `ON DELETE CASCADE`, so account deletion (#81) removes the row for free.
 *
 * `youversion_user_id` and `display_name` are the profile identity fetched
 * from `GET https://api.youversion.com/auth/me` at connect time and stored so
 * the settings screen can show "Connected as <name>" WITHOUT re-calling the
 * provider on every preferences read. Both are §9-safe: identity of the
 * connected account, never any highlight/activity data. `display_name` is not
 * in the original story column list — added here because the closed-shape
 * `youversionConnection.displayName` the response contract promises has to
 * come from somewhere, and storing it at connect time is the only way to
 * serve it without an extra outbound call on a hot read path.
 *
 * **2. `oauth_states.code_verifier`** — a nullable column on the EXISTING
 * server-side state store (migration 1720300000000). PKCE requires the
 * `code_verifier` generated at authorize time to be replayed, server-side,
 * at token-exchange time; it must never travel through the browser. The
 * `oauth_states` row already binds a single-use, expiry-checked, tamper-
 * evident `state` token to a `user_id` — carrying the verifier on that same
 * row reuses those exact properties rather than inventing a second store.
 * Nullable because the Google Calendar flow (which shares this table) does
 * NOT use PKCE and writes no verifier; only the YouVersion flow populates it.
 *
 * **3. `preferences.yv_write_highlights` / `yv_read_highlights`** — the two
 * granular consent gates for U4/U5, defaulting to FALSE (opt-in): connecting
 * an account is NOT consent to read or write highlights. Foundation §8's
 * "independently revocable consent categories", same shape as the existing
 * `calendar_enabled` / `health_enabled` / `communication_enabled` toggles —
 * except these default false (calendar defaults true because the OAuth grant
 * itself is the read consent there; here the two are deliberately separate).
 *
 * Like the adaptive-rhythm migration (1722500000000), this touches no
 * existing behavior on deploy day: the new consent flags start false, the
 * new table starts empty, and nothing reads any of it until the YouVersion
 * connect routes (this story) and the highlight sync (U4/U5) are wired.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('youversion_connections', {
    user_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    // Cloud-KMS ciphertext, never plaintext (Foundation §10). Access token
    // is always present after a successful exchange; the refresh token is
    // nullable because it is NOT yet confirmed that YouVersion issues one
    // (⚠️ must-confirm, U1) — the code handles its absence gracefully.
    access_token_encrypted: { type: 'bytea', notNull: true },
    refresh_token_encrypted: { type: 'bytea' },
    // Which KMS key version encrypted this row, for rotation — mirrors
    // connections.kms_key_version.
    kms_key_version: { type: 'text', notNull: true },
    // Access-token expiry (from the exchange's `expires_in`), NULL if the
    // provider does not report one.
    token_expires_at: { type: 'timestamptz' },
    // Profile identity from GET /auth/me — §9-safe (who is connected, never
    // what they read/highlighted).
    youversion_user_id: { type: 'text' },
    display_name: { type: 'text' },
    // Space-joined granted scopes string (the exact highlights scope is a
    // ⚠️ must-confirm value owned by U1) — kept as text, not text[], since we
    // store the raw `scope` string the token response echoes back.
    scopes: { type: 'text' },
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // PKCE verifier for the YouVersion flow — see the doc comment. Nullable;
  // the Google flow sharing this table never writes it.
  pgm.addColumn('oauth_states', {
    code_verifier: { type: 'text' },
  });

  // Granular highlight consent gates (U4/U5), opt-in — connecting an account
  // is not consent to read or write. Same shape as the existing consent
  // toggles, but default FALSE (see doc comment).
  pgm.addColumn('preferences', {
    yv_write_highlights: { type: 'boolean', notNull: true, default: false },
    yv_read_highlights: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('preferences', 'yv_read_highlights');
  pgm.dropColumn('preferences', 'yv_write_highlights');
  pgm.dropColumn('oauth_states', 'code_verifier');
  pgm.dropTable('youversion_connections');
}
