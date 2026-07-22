import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * docs/14_IMPROVEMENT_REVIEW.md §3.5 / issue #89: `preferences.voice`'s
 * column default (`en-US-Chirp3-HD-Kore`, migrations/1720000000000_init-
 * schema.ts) disagreed with `TtsService`'s own `DEFAULT_VOICE`
 * (`en-US-Chirp3-HD-Achernar`, apps/api/src/services/tts/ttsService.ts) —
 * two different "the default voice" constants that could each be changed
 * without anyone noticing the other. `TtsService`'s value is the one
 * actually pinned in code comments and exercised by its own test suite, so
 * it is the canonical one (see docs/00_FOUNDATION.md); this migration
 * brings the column default into agreement with it and backfills any
 * existing row that is still sitting on the old default (a user who
 * explicitly picked a different voice keeps that choice — only rows still
 * at the old, never-actually-used-by-TTS default are updated).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('preferences', 'voice', { default: 'en-US-Chirp3-HD-Achernar' });
  pgm.sql(
    `UPDATE preferences SET voice = 'en-US-Chirp3-HD-Achernar' WHERE voice = 'en-US-Chirp3-HD-Kore'`,
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('preferences', 'voice', { default: 'en-US-Chirp3-HD-Kore' });
}
