/**
 * The daily-run rhythm gate (#343) — everything that decides, per user,
 * whether today's scheduled devotional generates: the calendar time zone
 * refresh (K1 #187), the sabbath check (docs/14 §5.6, #94), the
 * active-days gate (K2 #188), and the adaptive rhythm evaluation + gate
 * (P6 #325, epic #312). Extracted verbatim from the middle of
 * routes/internal.ts's `/internal/trigger-daily-run` loop, which had grown
 * to ~850 lines with this ~300-line region inline; the route now owns
 * only the fan-out shape (auth, batch counters, generateNow, the
 * AlreadyExistsError-is-a-skip rule) and calls this evaluator per user.
 *
 * Behavior-preserving by construction: same decision order, same fail-open
 * postures, same log lines (the route passes its own `request.log` in), and
 * the route's response shape is untouched.
 */
import { DateTime } from 'luxon';
import type { PreferencesRepository, UsersRepository } from '../../db/repositories/index.js';
import { asVerifiedUserId } from '../../db/repositories/index.js';
import type { DailyRunCadenceRow } from '../../db/repositories/preferencesRepository.js';
import { loadAttendanceSignals, type AttendanceSignalsDeps } from './attendanceSignals.js';
import { decideCadence, type CadenceReason } from './cadencePolicy.js';
import { refreshCalendarTimezone } from '../calendar/refreshCalendarTimezone.js';

/** 0=Sunday..6=Saturday in `timezone`'s local time — same convention as `preferences.active_days`/`sabbath_day`. */
export function localDayOfWeek(now: Date, timezone: string): number {
  return DateTime.fromJSDate(now, { zone: timezone }).weekday % 7;
}

/** The slice of `InternalRoutesDeps` this gate reads — optionality (and its fail-open meaning) documented there. */
export interface DailyRunGateDeps {
  users: UsersRepository;
  preferences?: PreferencesRepository;
  rhythm?: AttendanceSignalsDeps;
  getCalendarTimeZoneForUser?: (userId: string) => Promise<string | undefined>;
}

/** Minimal pino-shaped logger — the route passes `request.log` so gate logs stay on the request's log stream. */
export interface DailyRunGateLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Per-run lookup context, built ONCE before the user loop — one query per
 * table for the whole batch rather than one `preferences.get()` per user.
 */
export interface DailyRunGateContext {
  sabbathByUserId: Map<string, { sabbath_day: number; sabbath_session: boolean }>;
  cadencePrefsByUserId: Map<string, DailyRunCadenceRow>;
}

export async function loadDailyRunGateContext(deps: DailyRunGateDeps): Promise<DailyRunGateContext> {
  // Sabbath awareness (docs/14 §5.6, issue #94): build a lookup of
  // sabbath-enabled users up front (one query) rather than one
  // preferences.get() per user in the loop.
  const sabbathByUserId = new Map<string, { sabbath_day: number; sabbath_session: boolean }>();
  if (deps.preferences) {
    const sabbathRows = await deps.preferences.listWithSabbathEnabled();
    for (const row of sabbathRows) {
      sabbathByUserId.set(row.user_id, row);
    }
  }

  // Active-days awareness (K2, issue #188). Same up-front-lookup shape as
  // the sabbath map above: one query for the batch, resolved per user
  // against that user's own zone.
  //
  // Until #188 the daily fan-out consulted nothing but
  // `listWithActiveGoogleCalendar()`, so `preferences.active_days` was
  // dead config (docs/03 §10) — a user who selected Mon–Fri still got a
  // Saturday devotional. A setting that changes nothing is a broken
  // promise, and a quiet one, because the user believes they were heard.
  //
  // P6 (#325): the same rows now also carry the cadence engine's inputs
  // (min_per_week + the adaptive_* state), so the adaptive evaluation
  // costs no extra query for non-adaptive users.
  const cadencePrefsByUserId = new Map<string, DailyRunCadenceRow>();
  if (deps.preferences) {
    for (const row of await deps.preferences.listActiveDays()) {
      cadencePrefsByUserId.set(row.user_id, row);
    }
  }

  return { sabbathByUserId, cadencePrefsByUserId };
}

/**
 * What the gate decided for one user. `timezoneRefreshed` and
 * `rhythmEvaluationError` ride alongside the decision because they can
 * accompany ANY of its variants (a zone can refresh and the user still
 * rest; the adaptive engine can fail open and the sabbath still rest) —
 * the route folds them into `timezonesRefreshed` / `errors` exactly as it
 * did when this logic was inline.
 */
export interface DailyRunGateOutcome {
  /** The zone every day-of-week decision below was made in (possibly just refreshed). */
  timezone: string;
  /** True when the calendar zone refresh actually moved this user's stored zone (K1 #187). */
  timezoneRefreshed: boolean;
  /**
   * Set when the adaptive engine threw and the gate failed open to the
   * full stated schedule (P6 ground rule). Reported in the run's `errors`
   * but NOT counted as `failed` — `failed` means "a user did not get
   * their devotional", and this user's generation still proceeds.
   */
  rhythmEvaluationError?: string;
  decision:
    | { action: 'generate'; sabbathSession: boolean }
    /** Genuine sabbath rest — no devotional generated today at all. */
    | { action: 'skip'; kind: 'sabbath_rest' }
    /** Today simply isn't one of their stated days (K2 #188). */
    | { action: 'skip'; kind: 'inactive_day' }
    /** A stated day the adaptive engine rested (P6 #325) — never conflated with inactive_day. */
    | { action: 'skip'; kind: 'rhythm'; reason: CadenceReason };
}

export async function evaluateDailyRunGate(
  deps: DailyRunGateDeps,
  context: DailyRunGateContext,
  user: { id: string; timezone: string },
  now: () => Date,
  log: DailyRunGateLogger,
): Promise<DailyRunGateOutcome> {
  // Refresh the zone BEFORE the sabbath check below, not after: that
  // check is the first thing here that reads `user.timezone`, and asking
  // "is today their sabbath" against a stale UTC default is how a user
  // in Sydney gets rested on the wrong day. #185 only ever learned the
  // zone at connect time, so anyone connected before it shipped is still
  // on UTC here, and nobody's zone follows them when they relocate.
  //
  // Best-effort by construction — `refreshCalendarTimezone` never
  // throws — because a revoked token or a Calendar 5xx for one user
  // must not cost that user (or anyone after them in the batch) their
  // devotional.
  let timezone = user.timezone;
  let timezoneRefreshed = false;
  if (deps.getCalendarTimeZoneForUser) {
    const refreshed = await refreshCalendarTimezone(
      { users: deps.users, getCalendarTimeZoneForUser: deps.getCalendarTimeZoneForUser },
      user.id,
    );
    if (refreshed.outcome === 'adopted' && refreshed.timezone) {
      timezone = refreshed.timezone;
      timezoneRefreshed = true;
      log.info({ userId: user.id, timezone }, 'daily run: refreshed calendar time zone');
    }
  }

  // Resolved once and reused by every gate below. `localDayOfWeek`
  // reads the *user's* zone, never the server's and never UTC: at
  // 2026-07-19T00:30Z a user in Australia/Sydney is already on Sunday
  // local while UTC still says Saturday, and a UTC-derived weekday
  // would rest them (or generate for them) a day out. That is the
  // exact defect class #205 fixed for the scheduling window; the day
  // of week is the same wall-clock-meets-UTC hazard one unit up.
  const today = localDayOfWeek(now(), timezone);

  const sabbath = context.sabbathByUserId.get(user.id);
  const isSabbathToday = sabbath !== undefined && today === sabbath.sabbath_day;

  // ── Adaptive rhythm evaluation (P6 #325, epic #312) ──────────────
  //
  // Runs BEFORE every gate below (sabbath included), so the engine's
  // state advances on schedule even on days this user generates
  // nothing — a back-off decided on their sabbath is still a back-off,
  // and deferring it would smear the one-step-per-week ladder across
  // whichever days happen to generate.
  //
  // Only entered for `adaptive_enabled = true` users: the policy's own
  // rule 1 would return `fixed_by_user` with the full stated day set
  // anyway, so skipping the signal reads for everyone else is pure
  // savings (three queries per adaptive user, zero for the rest) and
  // keeps non-adaptive scheduling byte-identical to K2 (#188).
  //
  // FAIL-OPEN, per the epic's ground rule: any error in the signal
  // reads or the policy for one user falls back to that user's full
  // stated `active_days` — logged and surfaced via
  // `rhythmEvaluationError`, but the devotional still generates. The
  // failure mode this must never have is "the adaptive engine broke and
  // silently stopped everyone's devotionals"; erring toward MORE
  // presence is the whole posture.
  const prefs = context.cadencePrefsByUserId.get(user.id);
  let effectiveDays = prefs?.active_days;
  let rhythmReason: CadenceReason | null = null;
  let rhythmEvaluationError: string | undefined;
  if (deps.rhythm && deps.preferences && prefs?.adaptive_enabled) {
    try {
      const rhythmNow = now();
      // P4's "since back-off" anchor: only an `easing_back` decision
      // counts as a back-off; `adaptive_decided_at` under any other
      // reason is just the rate limiter's clock.
      const lastBackoffAt =
        prefs.adaptive_reason === 'easing_back' ? prefs.adaptive_decided_at : null;
      const signals = await loadAttendanceSignals(deps.rhythm, asVerifiedUserId(user.id), {
        now: rhythmNow,
        lastBackoffAt,
      });
      const decision = decideCadence(
        signals,
        {
          activeDays: prefs.active_days,
          minPerWeek: prefs.min_per_week,
          adaptiveEnabled: prefs.adaptive_enabled,
          adaptiveDaysPerWeek: prefs.adaptive_days_per_week,
          adaptiveDecidedAt: prefs.adaptive_decided_at,
        },
        { now: rhythmNow },
      );

      // Persist ONLY when the decision actually moved the ladder —
      // never on a hold. `adaptive_decided_at` is doing double duty as
      // the 7-day rate limiter's clock and P4's "since back-off"
      // anchor (see `updateAdaptiveState`'s contract), so recording a
      // no-op would push that clock forward every day and freeze a
      // backed-off user below their ceiling forever. "Moved" is
      // measured against what the engine treats as the current level —
      // stored state, or the ceiling when never adapted (the policy's
      // own `?? ceiling` default) — so a fresh user holding at their
      // full schedule (`no_data`/`hold`) writes nothing and keeps a
      // null limiter clock.
      const ceiling = new Set(prefs.active_days).size;
      if (decision.daysPerWeek !== (prefs.adaptive_days_per_week ?? ceiling)) {
        await deps.preferences.updateAdaptiveState(asVerifiedUserId(user.id), {
          daysPerWeek: decision.daysPerWeek,
          reason: decision.reason,
          decidedAt: rhythmNow,
        });
      }

      effectiveDays = decision.effectiveDays;
      rhythmReason = decision.reason;
    } catch (err) {
      // Fall back to the full stated schedule. Surfaced via
      // `rhythmEvaluationError` so a broken engine is loud in the run
      // summary, but NOT counted in `failed` — see the field's doc.
      log.error(
        { userId: user.id, err: String(err) },
        'daily run: adaptive rhythm evaluation failed — failing open to full active_days',
      );
      rhythmEvaluationError = `adaptive rhythm evaluation failed (failed open, generation still attempted): ${String(err)}`;
      effectiveDays = prefs.active_days;
      rhythmReason = null;
    }
  }

  if (isSabbathToday && !sabbath!.sabbath_session) {
    // Genuine rest — no devotional generated today at all.
    return {
      timezone,
      timezoneRefreshed,
      rhythmEvaluationError,
      decision: { action: 'skip', kind: 'sabbath_rest' },
    };
  }

  // K2 (#188): the active-days gate. `active_days` is the single
  // source of truth for "does this user want a devotional today";
  // `cadence` is a derived label over the same set and is deliberately
  // NOT consulted here (see `cadenceForActiveDays` in
  // shared-contracts/src/api/preferences.ts for the full model).
  //
  // Ordered AFTER the sabbath check, and skipped entirely on a sabbath
  // day, on purpose. A sabbath day resolves wholly through the sabbath
  // rules: `sabbath_session` is an explicit opt-in that *names a
  // specific day* ("on my sabbath, give me the extended contemplative
  // session"), and the shipped defaults are `active_days = Mon–Fri`
  // with `sabbath_day = Sunday` — so gating the sabbath session on
  // active_days would make `sabbath_session` dead config for every
  // user holding the defaults. Fixing one silently-ignored preference
  // by silently ignoring another is not progress (#193).
  //
  // A user with no preferences row is not in the map at all. That must
  // fail OPEN — generate — rather than closed: the row is created on
  // first write, so a missing row means "this user has never expressed
  // a day preference", and reading that as "no days selected" would
  // withhold devotionals from a user who never asked for silence.
  const activeDays = prefs?.active_days;
  if (!isSabbathToday && activeDays !== undefined && !activeDays.includes(today)) {
    // A skip, not an error — the same treatment AlreadyExistsError
    // gets in the route. Today simply isn't one of their days; nothing
    // went wrong, nothing needs retrying, and nothing about this user
    // affects the rest of the batch.
    log.info(
      { userId: user.id, timezone, localDayOfWeek: today, activeDays },
      'daily run: skipped — not an active day for this user',
    );
    return {
      timezone,
      timezoneRefreshed,
      rhythmEvaluationError,
      decision: { action: 'skip', kind: 'inactive_day' },
    };
  }

  // P6 (#325): the adaptive-rhythm gate. Only reachable when today IS
  // one of the user's stated days (the K2 gate above already handled
  // "never their day") but the engine's current effective set rests it
  // — that distinction is why this is a separate check with its own
  // outcome kind rather than a merged day-set: "you chose not to have
  // Saturdays" and "we eased back your week" must never be
  // indistinguishable in the logs. Ordered after the sabbath check and
  // guarded by `!isSabbathToday` for exactly K2's reason: a sabbath
  // day resolves wholly through the sabbath rules, and gating the
  // opted-in sabbath session on effective days would make it dead
  // config. `rhythmReason !== null` scopes this to users the engine
  // actually decided for — fixed-schedule users, engine-less deploys,
  // and the fail-open path all pass straight through on `active_days`.
  if (
    !isSabbathToday &&
    rhythmReason !== null &&
    effectiveDays !== undefined &&
    !effectiveDays.includes(today)
  ) {
    log.info(
      { userId: user.id, timezone, localDayOfWeek: today, effectiveDays, reason: rhythmReason },
      'daily run: skipped by adaptive rhythm — today is outside the effective day set',
    );
    return {
      timezone,
      timezoneRefreshed,
      rhythmEvaluationError,
      decision: { action: 'skip', kind: 'rhythm', reason: rhythmReason },
    };
  }

  return {
    timezone,
    timezoneRefreshed,
    rhythmEvaluationError,
    decision: { action: 'generate', sabbathSession: isSabbathToday },
  };
}
