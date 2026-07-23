import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Adaptive rhythm preferences + engine state (Epic P #312, story P5 #324).
 *
 * Two kinds of column land here, and the distinction is load-bearing for
 * the API contract that sits in front of them:
 *
 * **User-owned (client-writable via `PUT /v1/preferences`):**
 *  - `min_per_week` — the floor. The cadence engine never schedules fewer
 *    days/week than this, no matter how long invitations go unjoined.
 *    Default **2**, per the epic's decision record: even a fully-lapsed
 *    user keeps two standing invitations — the product keeps showing up
 *    gently rather than fading to silence. CHECK 1..7 mirrors the Zod
 *    gate (`PreferencesUpdateRequestSchema.minPerWeek`) the same way the
 *    1720700000000 constraints back up their contract enums: the DB check
 *    is the last line, not the only one.
 *  - `adaptive_enabled` — the "keep my schedule fixed" opt-out. Default
 *    **true**: the feature IS the adaptivity (epic decision #2); the
 *    opt-out plus the P8 transparency card keep it honest. When false the
 *    engine is fully bypassed (`decideCadence` returns `fixed_by_user`
 *    before reading a single signal).
 *
 * **Server-owned engine state (never accepted from a client — the
 * contract has no field for them, and `PreferencesRepository.update`'s
 * client path cannot name them; only `updateAdaptiveState` writes them):**
 *  - `adaptive_days_per_week` — the engine's current effective days/week.
 *    NULL means "never adapted", which the policy treats as the ceiling
 *    (`|active_days|`): a new user gets their full stated schedule until
 *    real signals say otherwise.
 *  - `adaptive_reason` — the last decision's reason code. An enum in
 *    spirit; CHECKed to the `CadenceReason` union (cadencePolicy.ts) so a
 *    typo'd write fails loudly instead of feeding P8's copy layer a code
 *    it cannot render. Codes only, never prose, and never any count of
 *    missed sessions — Foundation §9: grace may notice, it may never
 *    charge.
 *  - `adaptive_decided_at` — when the state last *changed* (steps and
 *    clamps only; holds are not recorded). This single timestamp is both
 *    the one-step-per-week rate limiter and P4's definition of "since
 *    back-off", so writing it on a no-op hold would freeze the ladder —
 *    see `PreferencesRepository.updateAdaptiveState`'s doc.
 *
 * Like 1722100000000, this touches no existing row beyond giving every
 * user the defaults above — nobody's schedule changes on deploy day.
 * Schedules only change once #325 wires `decideCadence` into the daily
 * run, reading columns that until then are inert.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('preferences', {
    min_per_week: { type: 'smallint', notNull: true, default: 2 },
    adaptive_enabled: { type: 'boolean', notNull: true, default: true },
    adaptive_days_per_week: { type: 'smallint' },
    adaptive_reason: { type: 'text' },
    adaptive_decided_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('preferences', 'preferences_min_per_week_check', {
    check: 'min_per_week BETWEEN 1 AND 7',
  });
  pgm.addConstraint('preferences', 'preferences_adaptive_days_per_week_check', {
    check: 'adaptive_days_per_week IS NULL OR adaptive_days_per_week BETWEEN 1 AND 7',
  });
  pgm.addConstraint('preferences', 'preferences_adaptive_reason_check', {
    check:
      "adaptive_reason IS NULL OR adaptive_reason IN " +
      "('fixed_by_user', 'easing_back', 'welcoming_back', 'hold', 'at_floor', 'at_ceiling', 'no_data')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('preferences', 'preferences_adaptive_reason_check');
  pgm.dropConstraint('preferences', 'preferences_adaptive_days_per_week_check');
  pgm.dropConstraint('preferences', 'preferences_min_per_week_check');
  pgm.dropColumn('preferences', 'adaptive_decided_at');
  pgm.dropColumn('preferences', 'adaptive_reason');
  pgm.dropColumn('preferences', 'adaptive_days_per_week');
  pgm.dropColumn('preferences', 'adaptive_enabled');
  pgm.dropColumn('preferences', 'min_per_week');
}
