import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Initial Kairos schema — Architecture §2.4, cross-checked against
 * Foundation §5 (band enums), §6 (DevotionalOutput), §7 (tradition),
 * §8 (privacy: no raw health values, no event titles/attendees),
 * §9 (theological safety), §10 (security: encrypted tokens, unguessable
 * expiring session tokens).
 *
 * Forward-only per docs/06_DEPLOYMENT_CI_CD.md §5 ("fix-forward over down
 * migrations once an env has applied one") — `down` is still implemented
 * (useful for local dev resets) but production practice is fix-forward.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // --- enums (Foundation §5, §7, §6) ---------------------------------
  pgm.createType('tradition', ['evangelical', 'catholic', 'mainline', 'general']);
  pgm.createType('recovery_band', ['low', 'moderate', 'high']);
  pgm.createType('sleep_quality_band', ['poor', 'fair', 'good']);
  pgm.createType('activity_band', ['sedentary', 'moderate', 'active']);
  pgm.createType('busyness_band', ['light', 'moderate', 'heavy']);
  pgm.createType('communication_load_band', ['light', 'moderate', 'heavy']);
  pgm.createType('devotional_format', ['micro', 'short', 'standard', 'extended']);
  pgm.createType('devotional_status', [
    'pending',
    'generating',
    'ready',
    'delivered',
    'failed',
    'fixture',
  ]);
  pgm.createType('connection_provider', ['google_calendar']);
  pgm.createType('calendar_gap_source', ['found_gap', 'micro_gap', 'no_gap_skipped']);

  // --- users -----------------------------------------------------------
  // email is the only PII column in this schema; never sent to Gloo/
  // YouVersion (Foundation §8). userId (this table's id) is the sole
  // scoping key for every other table.
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    firebase_uid: { type: 'text', notNull: true, unique: true },
    email: { type: 'text', notNull: true },
    tradition: { type: 'tradition', notNull: true, default: 'general' },
    translation_id: { type: 'integer', notNull: true, default: 3034 }, // BSB — Foundation §4.3 default
    timezone: { type: 'text', notNull: true, default: 'UTC' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' }, // account deletion is a hard delete; nullable soft-marker for in-flight purge jobs
  });

  // --- connections -------------------------------------------------------
  // OAuth tokens are AES-256-GCM encrypted application-side before storage
  // (Foundation §10, Architecture §2.4); this table only ever holds
  // ciphertext + the nonce/tag needed to decrypt, never plaintext tokens.
  pgm.createTable('connections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    provider: { type: 'connection_provider', notNull: true },
    encrypted_refresh_token: { type: 'bytea', notNull: true },
    encryption_iv: { type: 'bytea', notNull: true },
    encryption_auth_tag: { type: 'bytea', notNull: true },
    kms_key_version: { type: 'text', notNull: true }, // which KMS DEK version encrypted this row, for rotation
    scopes: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    status: { type: 'text', notNull: true, default: 'active' }, // active | revoked | error
    connected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('connections', 'connections_user_provider_unique', {
    unique: ['user_id', 'provider'],
  });
  pgm.createIndex('connections', 'user_id');

  // --- preferences ---------------------------------------------------
  // One row per user (1:1). window/days define the scheduling search
  // space (Architecture §3.1); duration/tradition/translation/voice feed
  // the devotional engine; toggles gate the granular consent categories
  // (Foundation §8: calendar/health/communication independently revocable).
  pgm.createTable('preferences', {
    user_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    // Realistic workday window (09:00–17:00, #303) — the default search space
    // must span the workday, not a 2-hour pre-work slot. Kept in sync with
    // schedulingWindow.ts's DEFAULT_WINDOW_START/END fallbacks.
    window_start_local: { type: 'time', notNull: true, default: '09:00:00' },
    window_end_local: { type: 'time', notNull: true, default: '17:00:00' },
    active_days: {
      // 0=Sunday..6=Saturday
      type: 'smallint[]',
      notNull: true,
      default: pgm.func("'{1,2,3,4,5}'::smallint[]"),
    },
    cadence: { type: 'text', notNull: true, default: 'daily' }, // daily | weekdays | custom
    duration_preference: { type: 'devotional_format', notNull: true, default: 'short' },
    voice: { type: 'text', notNull: true, default: 'en-US-Chirp3-HD-Kore' },
    calendar_enabled: { type: 'boolean', notNull: true, default: false },
    health_enabled: { type: 'boolean', notNull: true, default: false },
    communication_enabled: { type: 'boolean', notNull: true, default: false },
    notify_on_skip: { type: 'boolean', notNull: true, default: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // --- daily_bands -----------------------------------------------------
  // Qualitative bands only — raw HealthKit values never reach the backend
  // at all (Foundation §8); this table cannot even represent a raw value.
  pgm.createTable('daily_bands', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    date: { type: 'date', notNull: true },
    recovery: { type: 'recovery_band' },
    sleep_quality: { type: 'sleep_quality_band' },
    activity: { type: 'activity_band' },
    busyness: { type: 'busyness_band' }, // derived backend-side from free/busy only
    communication_load: { type: 'communication_load_band' }, // null if not connected (Foundation §5)
    distress_signal: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('daily_bands', 'daily_bands_user_date_unique', {
    unique: ['user_id', 'date'],
  });
  pgm.createIndex('daily_bands', 'user_id');

  // --- devotionals -----------------------------------------------------
  // verses stored as JSONB array of {usfm, versionId, fetchedText,
  // attribution} matching packages/shared-contracts VerseSchema exactly.
  // audio_object is the private GCS object path, never a public URL
  // (Foundation §10) — signed URLs are minted at session-join time only.
  pgm.createTable('devotionals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    date: { type: 'date', notNull: true },
    format: { type: 'devotional_format', notNull: true },
    theme: { type: 'text', notNull: true },
    verses: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    devotional_body: { type: 'text', notNull: true },
    card_summary: { type: 'text', notNull: true },
    prayer: { type: 'text', notNull: true },
    journaling_prompt: { type: 'text' },
    action_step: { type: 'text' },
    audio_object: { type: 'text' }, // GCS object path; null until TTS completes
    status: { type: 'devotional_status', notNull: true, default: 'pending' },
    is_fixture_fallback: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('devotionals', 'devotionals_card_summary_length', {
    check: 'char_length(card_summary) <= 300',
  });
  pgm.createIndex('devotionals', 'user_id');
  pgm.createIndex('devotionals', ['user_id', 'date']);

  // --- sessions ----------------------------------------------------------
  // token is the unguessable capability URL id (Foundation §10: UUIDv4,
  // 122 bits entropy) — gen_random_uuid() satisfies that directly.
  pgm.createTable('sessions', {
    token: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    devotional_id: {
      type: 'uuid',
      notNull: true,
      references: 'devotionals',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    expires_at: { type: 'timestamptz', notNull: true },
    joined_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sessions', 'user_id');
  pgm.createIndex('sessions', 'devotional_id');
  pgm.createIndex('sessions', 'expires_at');

  // --- calendar_events -----------------------------------------------
  // provider_event_id references the Google Calendar event id only.
  // Event titles/attendees/notes/precise timestamps are NEVER persisted
  // here (Foundation §8) — only the gap metadata needed for reschedule
  // logic (Architecture §3.3).
  pgm.createTable('calendar_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    devotional_id: {
      type: 'uuid',
      references: 'devotionals',
      onDelete: 'CASCADE',
    },
    provider_event_id: { type: 'text', notNull: true },
    gap_source: { type: 'calendar_gap_source', notNull: true },
    gap_start_at: { type: 'timestamptz', notNull: true },
    gap_end_at: { type: 'timestamptz', notNull: true },
    reschedule_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('calendar_events', 'calendar_events_user_provider_event_unique', {
    unique: ['user_id', 'provider_event_id'],
  });
  pgm.createIndex('calendar_events', 'user_id');
  pgm.createIndex('calendar_events', 'devotional_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('calendar_events');
  pgm.dropTable('sessions');
  pgm.dropTable('devotionals');
  pgm.dropTable('daily_bands');
  pgm.dropTable('preferences');
  pgm.dropTable('connections');
  pgm.dropTable('users');

  pgm.dropType('calendar_gap_source');
  pgm.dropType('connection_provider');
  pgm.dropType('devotional_status');
  pgm.dropType('devotional_format');
  pgm.dropType('communication_load_band');
  pgm.dropType('busyness_band');
  pgm.dropType('activity_band');
  pgm.dropType('sleep_quality_band');
  pgm.dropType('recovery_band');
  pgm.dropType('tradition');
}
