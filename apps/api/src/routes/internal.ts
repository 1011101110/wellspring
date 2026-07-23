/**
 * Internal, non-public API surface (docs/03_API_INTEGRATION_SPEC.md §8.3 /
 * docs/14_IMPROVEMENT_REVIEW.md §4.1, issue #74). Defines three routes:
 *
 *   POST /internal/generate-now     — generate a devotional for one user
 *   POST /internal/trigger-daily-run — batch generate for all Google Calendar
 *                                      connected users (issue #28 C7)
 *   POST /internal/trigger-examen-run — batch generate the evening examen
 *                                      slot for all examen_enabled users
 *                                      (docs/14 §5.3, issue #77)
 *   POST /internal/purge            — run the retention/purge sweeps
 *                                      (issue #82, purgeJobs.ts)
 *   POST /internal/backfill-timezones — adopt the calendar zone for users
 *                                      still on the UTC default (K1, #187)
 *
 * Auth: a shared-secret header, `X-Internal-Token`, checked against
 * `INTERNAL_API_TOKEN` from the environment. If `INTERNAL_API_TOKEN` is
 * unset/empty, every request is rejected (fail-closed).
 *
 * Replacing with real OIDC-token verification (Cloud Run's built-in
 * service-to-service auth) is tracked as follow-up work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { GenerateNowOrchestrator } from '../services/orchestrator/generateNowOrchestrator.js';
import { AlreadyExistsError } from '../services/orchestrator/generateNowOrchestrator.js';
import type { PreferencesRepository, UsersRepository } from '../db/repositories/index.js';
import { asVerifiedUserId } from '../db/repositories/index.js';
import type { DailyRunCadenceRow } from '../db/repositories/preferencesRepository.js';
import { loadAttendanceSignals, type AttendanceSignalsDeps } from '../services/rhythm/attendanceSignals.js';
import { decideCadence, type CadenceReason } from '../services/rhythm/cadencePolicy.js';
import { runAllPurgeJobs, type PurgeJobsDeps } from '../services/retention/purgeJobs.js';
import { runRescheduleCheck, type RescheduleWatcherDeps } from '../services/calendar/rescheduleWatcher.js';
import { refreshCalendarTimezone } from '../services/calendar/refreshCalendarTimezone.js';
import { runMeetBotDispatch } from '../services/meetBot/meetBotSession.js';
import type { AttendeeClient } from '../services/meetBot/attendeeClient.js';
import {
  checkMeetBotConsent,
  type MeetBotConsentGateDeps,
} from '../services/meetBot/meetBotConsentGate.js';
import { deriveMeetBotAudioToken } from '../services/meetBot/meetBotAudioCapabilityToken.js';

export interface InternalRoutesDeps {
  generateNowOrchestrator: GenerateNowOrchestrator;
  /** Required for /internal/trigger-daily-run. When omitted, that route returns 501. */
  users?: UsersRepository;
  /**
   * Required for /internal/trigger-examen-run. When omitted, that route
   * returns 501. Also used (optionally) by /internal/trigger-daily-run's
   * sabbath gate (docs/14 §5.6, issue #94) and its active-days gate (K2,
   * issue #188) — when omitted there, both are simply disabled and every
   * user's daily devotional generates as before. Fail-open is the right
   * default for a missing dependency in a fan-out whose job is to deliver
   * something: a misconfigured deploy should not silently stop generating.
   */
  preferences?: PreferencesRepository;
  /**
   * P6 (#325): the attendance-signal readers behind
   * /internal/trigger-daily-run's adaptive-rhythm gate — P4's
   * `loadAttendanceSignals` needs a sessions repository and a
   * `FeedbackSignalSource` (sessionFeedbackSignalSource.ts). Optional with
   * the same fail-open posture as `preferences` above, and for the same
   * reason: when omitted, the engine is simply disabled and every user is
   * gated on their raw `active_days` exactly as before this story — a
   * misconfigured deploy must degrade to MORE presence, never less.
   */
  rhythm?: AttendanceSignalsDeps;
  /**
   * Required for /internal/purge. When omitted, that route returns 501.
   * `now` is intentionally NOT part of this — production always uses the
   * real clock; only tests inject one directly into runAllPurgeJobs.
   */
  purgeJobs?: Omit<PurgeJobsDeps, 'now'>;
  /**
   * Required for /internal/trigger-reschedule-check (issue #25). When
   * omitted, that route returns 501 — same pattern as `purgeJobs` above.
   * `now` is intentionally NOT part of this either, for the same reason.
   */
  rescheduleWatcher?: Omit<RescheduleWatcherDeps, 'now'>;
  /**
   * Required for /internal/dispatch-meetbot (H1c, #131). When omitted,
   * that route returns 501 — same pattern as the deps above.
   */
  meetBotDispatch?: {
    attendeeClient: AttendeeClient;
    /**
     * `wss://.../meetbot/audio` — the per-devotional capability token and
     * the devotionalId are both appended here, at dispatch time.
     *
     * This used to be the base URL with the global `MEETBOT_AUDIO_TOKEN`
     * already baked into it, because the token was the same for every
     * devotional. It no longer is (#221): the token is now derived per
     * devotional, so it cannot be pre-computed into a static base and this
     * field carries no secret at all.
     */
    audioWebsocketBaseUrl: string;
    /**
     * Root secret from which each dispatch's per-devotional audio
     * capability token is derived (#221) — the value of
     * `MEETBOT_AUDIO_TOKEN`, NOT a token that ever appears in a URL. See
     * services/meetBot/meetBotAudioCapabilityToken.ts.
     *
     * Required, like `consentGate`: without it this route cannot mint a
     * URL the audio websocket will accept, and there is no sensible
     * degraded mode — a dispatch with an unverifiable URL produces a bot
     * that joins a meeting and then cannot speak.
     */
    audioTokenSecret: string;
    /**
     * Fire-time consent gate deps (#217). REQUIRED, not optional, unlike
     * every other dependency in this interface — and that asymmetry is
     * the point. The `?` on the deps above buys a route that returns 501
     * when unconfigured, i.e. fails safe by doing nothing. An optional
     * consent gate would fail the other way: a deploy that forgot to wire
     * it would dispatch bots with no consent check at all, which is the
     * exact defect #217 exists to remove. Making it required moves that
     * mistake from a silent production consent violation to a `tsc`
     * error.
     */
    consentGate: MeetBotConsentGateDeps;
  };
  /**
   * K1 (#187): resolves a user's connected-calendar IANA zone. Powers the
   * per-user zone refresh inside `/internal/trigger-daily-run` and the
   * whole of `/internal/backfill-timezones` (which returns 501 without
   * it). Optional and narrow — a single callback rather than
   * (connections + kmsService + calendarClient) — matching
   * `ConnectRoutesDeps.getCalendarTimeZone`; a deploy without Calendar
   * env vars configured simply doesn't refresh zones, exactly as it
   * doesn't run the reschedule watcher.
   */
  getCalendarTimeZoneForUser?: (userId: string) => Promise<string | undefined>;
  /** Defaults to `process.env.INTERNAL_API_TOKEN`. Injectable for tests. */
  internalApiToken?: string;
  /** Injectable clock for the trigger-daily-run sabbath-day check (issue #94). Defaults to the real clock. */
  now?: () => Date;
}

/** 0=Sunday..6=Saturday in `timezone`'s local time — same convention as `preferences.active_days`/`sabbath_day`. */
function localDayOfWeek(now: Date, timezone: string): number {
  return DateTime.fromJSDate(now, { zone: timezone }).weekday % 7;
}

const GenerateNowRequestSchema = z.object({
  userId: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
    .optional(),
});

const DispatchMeetBotRequestSchema = z.object({
  meetingUrl: z.string().min(1),
  devotionalId: z.string().min(1),
  botName: z.string().min(1).optional(),
});

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: { code: 'AUTH_FAILED', message: 'Missing or invalid internal token', retryable: false },
  });
}

function badRequest(reply: FastifyReply, message = 'Invalid request body') {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

/**
 * Placeholder shared-secret check — see file header. Constant-time-ish via
 * simple length+equality check is not strictly required here (this is not
 * a cryptographic session token comparison against a per-request secret at
 * scale, and Node's string `===` timing signal on a short shared token
 * checked by trusted internal infra is an accepted, documented gap for
 * this dev-only placeholder — real OIDC verification replaces this
 * entirely before any real internet exposure).
 */
function verifyInternalToken(request: FastifyRequest, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false; // fail-closed: no token configured -> reject everything.
  const provided = request.headers['x-internal-token'];
  return typeof provided === 'string' && provided === expectedToken;
}

/**
 * Registers `/internal/*` routes on `app`.
 */
export function registerInternalRoutes(app: FastifyInstance, deps: InternalRoutesDeps): void {
  const { generateNowOrchestrator } = deps;
  const expectedToken = deps.internalApiToken ?? process.env.INTERNAL_API_TOKEN;
  const now = deps.now ?? (() => new Date());

  // POST /internal/generate-now — generate a devotional for a single user.
  app.post<{ Body: unknown }>('/internal/generate-now', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    const parsed = GenerateNowRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const result = await generateNowOrchestrator.generateNow({
      userId: parsed.data.userId,
      date: parsed.data.date,
    });

    return {
      ok: true,
      sessionUrl: result.sessionUrl,
      devotionalId: result.devotionalId,
      data: {
        sessionToken: result.sessionToken,
        source: result.source,
        audio: result.audio,
        devotional: result.devotional,
        ...(result.calendar !== undefined ? { calendar: result.calendar } : {}),
      },
    };
  });

  // POST /internal/trigger-daily-run — fan-out generate-now for all users
  // with an active Google Calendar connection (issue #28 C7). Designed for
  // Cloud Scheduler: idempotent per user (AlreadyExistsError is a skip, not
  // a failure), errors are collected and returned but never abort the batch.
  app.post<{ Body: unknown }>('/internal/trigger-daily-run', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.users) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'users repository not wired for this route', retryable: false },
      });
    }

    const users = await deps.users.listWithActiveGoogleCalendar();
    const triggered = users.length;
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    const errors: Array<{ userId: string; reason: string }> = [];

    // Sabbath awareness (docs/14 §5.6, issue #94): build a lookup of
    // sabbath-enabled users up front (one query) rather than one
    // preferences.get() per user in the loop below.
    const sabbathByUserId = new Map<string, { sabbath_day: number; sabbath_session: boolean }>();
    if (deps.preferences) {
      const sabbathRows = await deps.preferences.listWithSabbathEnabled();
      for (const row of sabbathRows) {
        sabbathByUserId.set(row.user_id, row);
      }
    }

    // Active-days awareness (K2, issue #188). Same up-front-lookup shape as
    // the sabbath map above: one query for the batch, resolved per user
    // below against that user's own zone.
    //
    // Until #188 this fan-out consulted nothing but
    // `listWithActiveGoogleCalendar()`, so `preferences.active_days` was
    // dead config (docs/03 §10) — a user who selected Mon–Fri still got a
    // Saturday devotional. A setting that changes nothing is a broken
    // promise, and a quiet one, because the user believes they were heard.
    //
    // P6 (#325): the same rows now also carry the cadence engine's inputs
    // (min_per_week + the adaptive_* state), so the adaptive evaluation in
    // the loop below costs no extra query for non-adaptive users.
    const cadencePrefsByUserId = new Map<string, DailyRunCadenceRow>();
    if (deps.preferences) {
      for (const row of await deps.preferences.listActiveDays()) {
        cadencePrefsByUserId.set(row.user_id, row);
      }
    }

    // P6 (#325): users whose stated day it was, but whose devotional the
    // adaptive rhythm engine rested today. Reported in the run summary
    // (and therefore in Cloud Logging per execution — the #286 lesson:
    // cron work fails invisibly) so "why didn't I get one today?" is
    // answerable from a single log line. Reason codes only, never counts
    // of missed sessions (§9).
    const skippedByRhythm: Array<{ userId: string; reason: CadenceReason }> = [];

    // K1 (#187): how many users' zones this run actually moved. Reported
    // in the response so a Cloud Scheduler run's logs show whether the
    // refresh is doing anything, without needing a separate query.
    let timezonesRefreshed = 0;

    for (const user of users) {
      // Refresh the zone BEFORE the sabbath check below, not after: that
      // check is the first thing in this loop that reads `user.timezone`,
      // and asking "is today their sabbath" against a stale UTC default
      // is how a user in Sydney gets rested on the wrong day. #185 only
      // ever learned the zone at connect time, so anyone connected before
      // it shipped is still on UTC here, and nobody's zone follows them
      // when they relocate.
      //
      // Best-effort by construction — `refreshCalendarTimezone` never
      // throws — because a revoked token or a Calendar 5xx for one user
      // must not cost that user (or anyone after them in this loop) their
      // devotional.
      let timezone = user.timezone;
      if (deps.getCalendarTimeZoneForUser) {
        const refreshed = await refreshCalendarTimezone(
          { users: deps.users, getCalendarTimeZoneForUser: deps.getCalendarTimeZoneForUser },
          user.id,
        );
        if (refreshed.outcome === 'adopted' && refreshed.timezone) {
          timezone = refreshed.timezone;
          timezonesRefreshed++;
          request.log.info(
            { userId: user.id, timezone },
            'daily run: refreshed calendar time zone',
          );
        }
      }

      // Resolved once and reused by both gates below. `localDayOfWeek`
      // reads the *user's* zone, never the server's and never UTC: at
      // 2026-07-19T00:30Z a user in Australia/Sydney is already on Sunday
      // local while UTC still says Saturday, and a UTC-derived weekday
      // would rest them (or generate for them) a day out. That is the
      // exact defect class #205 fixed for the scheduling window; the day
      // of week is the same wall-clock-meets-UTC hazard one unit up.
      const today = localDayOfWeek(now(), timezone);

      const sabbath = sabbathByUserId.get(user.id);
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
      // stated `active_days` — logged and surfaced in `errors`, but the
      // devotional still generates. The failure mode this must never have
      // is "the adaptive engine broke and silently stopped everyone's
      // devotionals"; erring toward MORE presence is the whole posture.
      const prefs = cadencePrefsByUserId.get(user.id);
      let effectiveDays = prefs?.active_days;
      let rhythmReason: CadenceReason | null = null;
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
          // Fall back to the full stated schedule. Surfaced in `errors` so
          // a broken engine is loud in the run summary, but NOT counted in
          // `failed` — `failed` means "a user did not get their
          // devotional", and this user is about to get theirs.
          request.log.error(
            { userId: user.id, err: String(err) },
            'daily run: adaptive rhythm evaluation failed — failing open to full active_days',
          );
          errors.push({
            userId: user.id,
            reason: `adaptive rhythm evaluation failed (failed open, generation still attempted): ${String(err)}`,
          });
          effectiveDays = prefs.active_days;
          rhythmReason = null;
        }
      }

      if (isSabbathToday && !sabbath!.sabbath_session) {
        // Genuine rest — no devotional generated today at all.
        skipped++;
        continue;
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
        // gets below. Today simply isn't one of their days; nothing went
        // wrong, nothing needs retrying, and nothing about this user
        // affects the rest of the batch.
        skipped++;
        request.log.info(
          { userId: user.id, timezone, localDayOfWeek: today, activeDays },
          'daily run: skipped — not an active day for this user',
        );
        continue;
      }

      // P6 (#325): the adaptive-rhythm gate. Only reachable when today IS
      // one of the user's stated days (the K2 gate above already handled
      // "never their day") but the engine's current effective set rests it
      // — that distinction is why this is a separate check with its own
      // `skippedByRhythm` entry rather than a merged day-set: "you chose
      // not to have Saturdays" and "we eased back your week" must never be
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
        skipped++;
        skippedByRhythm.push({ userId: user.id, reason: rhythmReason });
        request.log.info(
          { userId: user.id, timezone, localDayOfWeek: today, effectiveDays, reason: rhythmReason },
          'daily run: skipped by adaptive rhythm — today is outside the effective day set',
        );
        continue;
      }

      try {
        await generateNowOrchestrator.generateNow({
          userId: user.id,
          ...(isSabbathToday ? { sabbathSession: true } : {}),
        });
        succeeded++;
      } catch (err) {
        if (err instanceof AlreadyExistsError) {
          // Idempotent skip — devotional already generated for today.
          skipped++;
        } else {
          failed++;
          errors.push({ userId: user.id, reason: String(err) });
        }
      }
    }

    return {
      ok: true,
      triggered,
      succeeded,
      skipped,
      failed,
      errors,
      timezonesRefreshed,
      skippedByRhythm,
    };
  });

  // POST /internal/backfill-timezones — K1 (#187). One-off (but idempotent
  // and safe to re-run) sweep over users whose zone nobody has ever set:
  // #185 adopts the calendar zone at connect time only, so every user who
  // connected before it shipped is still on the `'UTC'` column default,
  // and every one of them is getting their devotional at the wrong hour.
  //
  // Deliberately an endpoint rather than a script under scripts/: it
  // reuses the exact refresh path the daily run uses (so there is one
  // behavior to reason about, not two), it runs with the deployed
  // service's own credentials instead of needing a local KMS/OAuth setup,
  // and it is reachable in the environment where the affected rows
  // actually live.
  //
  // Reaches only calendar-connected users — see
  // `listAwaitingCalendarTimezone`. Users with no calendar have no
  // server-side zone signal at all; their device zone arrives on the next
  // preferences sync instead.
  app.post('/internal/backfill-timezones', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.users || !deps.getCalendarTimeZoneForUser) {
      return reply.status(501).send({
        ok: false,
        error: {
          code: 'NOT_CONFIGURED',
          message: 'users repository or calendar time zone lookup not wired for this route',
          retryable: false,
        },
      });
    }

    const userIds = await deps.users.listAwaitingCalendarTimezone();
    const refreshDeps = {
      users: deps.users,
      getCalendarTimeZoneForUser: deps.getCalendarTimeZoneForUser,
    };

    let updated = 0;
    let unchanged = 0;
    let unavailable = 0;
    let failed = 0;

    for (const userId of userIds) {
      const { outcome } = await refreshCalendarTimezone(refreshDeps, userId);
      if (outcome === 'adopted') updated++;
      else if (outcome === 'unchanged') unchanged++;
      else if (outcome === 'failed' || outcome === 'rejected') failed++;
      // 'unavailable' — connection exists but the calendar told us
      // nothing (commonly a token revoked on Google's side without our
      // `connections.status` catching up). Counted separately from
      // `failed` because it is not an error to fix, just a user this
      // sweep cannot reach.
      else unavailable++;
    }

    const result = { examined: userIds.length, updated, unchanged, unavailable, failed };
    request.log.info({ result }, 'timezone backfill completed');
    return { ok: true, ...result };
  });

  // POST /internal/trigger-examen-run — fan-out the evening examen slot for
  // every user with examen_enabled=true (docs/14 §5.3, issue #77). Same
  // idempotent-skip/error-collection shape as trigger-daily-run, but keyed
  // to preferences.examen_enabled rather than an active Google Calendar
  // connection, and calls generateNow with slotType: 'examen' + skipCalendar:
  // true (the calendar step's "tomorrow's window" insertion is a
  // morning-slot-only concept — generateNowOrchestrator also auto-skips it
  // for any non-'standard' slot, so this is belt-and-suspenders).
  app.post<{ Body: unknown }>('/internal/trigger-examen-run', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.preferences) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'preferences repository not wired for this route', retryable: false },
      });
    }

    const users = await deps.preferences.listWithExamenEnabled();
    const triggered = users.length;
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    const errors: Array<{ userId: string; reason: string }> = [];

    for (const user of users) {
      try {
        await generateNowOrchestrator.generateNow({
          userId: user.user_id,
          slotType: 'examen',
          skipCalendar: true,
        });
        succeeded++;
      } catch (err) {
        if (err instanceof AlreadyExistsError) {
          // Idempotent skip — examen already generated for today.
          skipped++;
        } else {
          failed++;
          errors.push({ userId: user.user_id, reason: String(err) });
        }
      }
    }

    return {
      ok: true,
      triggered,
      succeeded,
      skipped,
      failed,
      errors,
    };
  });

  // POST /internal/purge — runs the retention sweeps (issue #82,
  // purgeJobs.ts): daily_bands 90d, devotional audio 14d, expired sessions
  // 7d-past-expiry. Designed for Cloud Scheduler, same shared-secret auth
  // as the routes above. Idempotent (a sweep with nothing to purge is a
  // no-op, not an error) and safe to run more often than strictly needed.
  app.post('/internal/purge', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.purgeJobs) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'purge job dependencies not wired for this route', retryable: false },
      });
    }

    const result = await runAllPurgeJobs(deps.purgeJobs, () => deps.purgeJobs!.users.listAllIds());
    request.log.info({ result }, 'retention purge sweep completed');
    return { ok: true, ...result };
  });

  // POST /internal/trigger-reschedule-check — poll-based half of the
  // reschedule watcher (issue #25): for every user with an active Google
  // Calendar connection, re-check each of their future Wellspring calendar
  // events against a fresh freeBusy call and move any whose gap got
  // booked. Designed for a frequent (e.g. 15-min) Cloud Scheduler job —
  // same shared-secret auth as the routes above, and safe to run more
  // often than strictly needed (a conflict-free check is a cheap no-op).
  app.post('/internal/trigger-reschedule-check', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.rescheduleWatcher || !deps.users) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'reschedule watcher dependencies not wired for this route', retryable: false },
      });
    }

    const activeUsers = await deps.users.listWithActiveGoogleCalendar();
    const result = await runRescheduleCheck(deps.rescheduleWatcher, activeUsers.map((u) => u.id));
    request.log.info({ result }, 'reschedule check completed');
    return { ok: true, ...result };
  });

  // POST /internal/dispatch-meetbot — H1c (#131): the Cloud-Tasks-scheduled
  // callback that actually dispatches an Attendee bot at gap_start_at.
  // Same shared-secret auth as every other /internal/* route — this is a
  // GCP-internal caller (our own Cloud Tasks queue), never a third party,
  // so reusing INTERNAL_API_TOKEN here is consistent with the daily-run/
  // examen/purge/reschedule-check routes above (unlike routes/meetBotAudio.ts's
  // MEETBOT_AUDIO_TOKEN, whose URL is sent to Attendee, an actual third party).
  //
  // Gated on live consent at fire time (#217) — see the block inside the
  // handler. That gate is why a refusal here returns 200 rather than an
  // error status: Cloud Tasks retries anything non-2xx.
  //
  // ⚠️ Not idempotent against Cloud Tasks retries: a retried delivery
  // creates a second bot rather than deduplicating. Acceptable for now —
  // the queue's own retry-count config (set when the queue is created,
  // an owner action per issue #131) is the first line of defense; real
  // dedup would need a bot-already-dispatched marker, not yet built.
  app.post<{ Body: unknown }>('/internal/dispatch-meetbot', async (request, reply) => {
    if (!verifyInternalToken(request, expectedToken)) {
      return unauthorized(reply);
    }

    if (!deps.meetBotDispatch) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'meetBotDispatch dependencies not wired for this route', retryable: false },
      });
    }

    const parsed = DispatchMeetBotRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const { meetingUrl, devotionalId, botName } = parsed.data;

    // ── Fire-time consent gate (#217, epic #186) ──────────────────────
    //
    // Runs BEFORE anything that could create an Attendee bot. The task in
    // the queue was enqueued at generation time, hours before this moment;
    // consent can have been withdrawn in between, by an explicit calendar
    // disconnect or by deleting the account outright. See
    // services/meetBot/meetBotConsentGate.ts for the full rationale and
    // for why this — not dequeuing the task on revoke — is the primary fix.
    //
    // On the response semantics, which are load-bearing:
    //
    // Cloud Tasks treats ONLY a 2xx as success. Every other status,
    // including 4xx, is a failure that gets retried per the queue's retry
    // config (`maxAttempts: 2`) and then dead-lettered. So a refusal must
    // return 2xx or the queue will re-deliver it and we will re-refuse —
    // burning the retry budget to reach the same answer, and turning a
    // clean privacy decision into log noise that looks like a malfunction.
    // Returning 403/409/500 here would be "more semantically honest" about
    // the refusal and operationally wrong.
    //
    // Hence 200 with `dispatched: false`. `ok: true` is not a claim that a
    // bot joined; it is the claim this endpoint is actually making to its
    // only caller — "this task is complete, do not retry it". A refusal is
    // a *successful* outcome of the task: the system did precisely what it
    // should. The `dispatched` flag, not the status code, is what tells a
    // human reader whether a bot ran.
    //
    // A repository failure is the opposite case and is deliberately not
    // caught here: it means we could not determine consent, which is not
    // the same as knowing it was withdrawn. Letting it throw produces a
    // 500, Cloud Tasks retries, and — crucially — no bot is created on
    // either attempt. Fail-closed on the way to failing loudly.
    const decision = await checkMeetBotConsent(deps.meetBotDispatch.consentGate, devotionalId);
    if (!decision.allowed) {
      // Audit trail (docs/04_DATA_PRIVACY_SECURITY.md §2). Deliberately
      // logs opaque internal ids and a fixed enum reason only — never the
      // meeting URL (which is a live join credential for someone's private
      // meeting) and never an email. `warn`, not `info`: a refusal is
      // correct behavior but always worth a second look, because a spike
      // in refusals means something upstream is enqueueing tasks it
      // shouldn't.
      request.log.warn(
        {
          devotionalId,
          userId: decision.userId,
          reason: decision.reason,
        },
        'meetbot dispatch refused — consent no longer valid at fire time (#217)',
      );
      return {
        ok: true,
        dispatched: false,
        reason: decision.reason,
      };
    }

    // Mint a capability scoped to THIS devotional (#221). What we hand
    // Attendee is now a URL that authorizes streaming one devotional —
    // this one — rather than a URL containing a global secret that would
    // authorize streaming anyone's. See
    // services/meetBot/meetBotAudioCapabilityToken.ts.
    const audioToken = deriveMeetBotAudioToken(deps.meetBotDispatch.audioTokenSecret, devotionalId);
    const audioWebsocketUrl = `${deps.meetBotDispatch.audioWebsocketBaseUrl}/${audioToken}/${devotionalId}`;

    const result = await runMeetBotDispatch(
      { meetingUrl, botName: botName ?? 'Wellspring', audioWebsocketUrl },
      { attendeeClient: deps.meetBotDispatch.attendeeClient },
    );
    request.log.info({ devotionalId, userId: decision.userId, result }, 'meetbot dispatch completed');
    return { ok: result.ok, dispatched: true, result };
  });
}
