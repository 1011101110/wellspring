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
import { z } from 'zod';
import type { GenerateNowOrchestrator } from '../services/orchestrator/generateNowOrchestrator.js';
import { AlreadyExistsError } from '../services/orchestrator/generateNowOrchestrator.js';
import type { PreferencesRepository, UsersRepository } from '../db/repositories/index.js';
import type { AttendanceSignalsDeps } from '../services/rhythm/attendanceSignals.js';
import type { CadenceReason } from '../services/rhythm/cadencePolicy.js';
import {
  evaluateDailyRunGate,
  loadDailyRunGateContext,
} from '../services/rhythm/dailyRunGate.js';
import { runAllPurgeJobs, type PurgeJobsDeps } from '../services/retention/purgeJobs.js';
import { runRescheduleCheck, type RescheduleWatcherDeps } from '../services/calendar/rescheduleWatcher.js';
import { refreshCalendarTimezone } from '../services/calendar/refreshCalendarTimezone.js';
import { runMeetBotDispatch, type MeetBotDispatchParams } from '../services/meetBot/meetBotSession.js';
import type { AttendeeClient } from '../services/meetBot/attendeeClient.js';
import {
  checkMeetBotConsent,
  type MeetBotConsentGateDeps,
} from '../services/meetBot/meetBotConsentGate.js';
import { deriveMeetBotAudioToken } from '../services/meetBot/meetBotAudioCapabilityToken.js';
import { stageUrlFor } from '../services/delivery/sessionUrls.js';

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
   *
   * A mode union since Epic Q (#335): `websocket` is the pre-existing
   * PCM path (default when `mode` is omitted, so every existing wiring
   * and test keeps meaning what it meant); `voice-agent` makes dispatch
   * create bots that load the Stage page (`/stage/:token`) in Attendee's
   * container instead of connecting to our audio websocket. Deployment
   * config picks the mode — see index.ts (`MEETBOT_IMMEDIATE_DISPATCH`,
   * #336, wires voice-agent mode).
   */
  meetBotDispatch?: {
    attendeeClient: AttendeeClient;
    /**
     * Fire-time consent gate deps (#217). REQUIRED, not optional, unlike
     * every other dependency in this interface — and that asymmetry is
     * the point. The `?` on the deps above buys a route that returns 501
     * when unconfigured, i.e. fails safe by doing nothing. An optional
     * consent gate would fail the other way: a deploy that forgot to wire
     * it would dispatch bots with no consent check at all, which is the
     * exact defect #217 exists to remove. Making it required moves that
     * mistake from a silent production consent violation to a `tsc`
     * error. Mode-independent: it runs BEFORE bot creation in both modes.
     */
    consentGate: MeetBotConsentGateDeps;
  } & (
    | {
        mode?: 'websocket';
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
      }
    | {
        mode: 'voice-agent';
        /**
         * Read-only session-token lookup (#335): voice-agent dispatch
         * resolves the devotional's EXISTING session token to build the
         * Stage URL. Never mints a session — a devotional without one
         * refuses with `no_session` (200 + dispatched:false, same
         * Cloud-Tasks-retry posture as a consent refusal). Structural
         * (`SessionsRepository.findByDevotionalId` satisfies it) so tests
         * fake exactly the one read the route performs.
         */
        sessions: { findByDevotionalId(devotionalId: string): Promise<{ token: string } | null> };
        /**
         * Absolute origin the Stage URL is built from — same value the
         * orchestrator derives sessionUrl from (`PUBLIC_BASE_URL`).
         */
        publicBaseUrl: string;
      }
  );
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

    // The rhythm gate — sabbath, active-days, adaptive rhythm, and the
    // per-user calendar-zone refresh — lives in services/rhythm/
    // dailyRunGate.ts (#343). This route keeps only the fan-out shape:
    // batch counters, generateNow, and the AlreadyExistsError-is-a-skip
    // rule. Context is one query per table for the whole batch.
    const gateDeps = {
      users: deps.users,
      preferences: deps.preferences,
      rhythm: deps.rhythm,
      getCalendarTimeZoneForUser: deps.getCalendarTimeZoneForUser,
    };
    const gateContext = await loadDailyRunGateContext(gateDeps);

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
      const outcome = await evaluateDailyRunGate(gateDeps, gateContext, user, now, request.log);
      if (outcome.timezoneRefreshed) timezonesRefreshed++;
      if (outcome.rhythmEvaluationError) {
        // Fail-open adaptive-engine error (see DailyRunGateOutcome):
        // loud in the run summary, but NOT counted in `failed` —
        // `failed` means "a user did not get their devotional", and
        // when the decision below is `generate` this user still does.
        errors.push({ userId: user.id, reason: outcome.rhythmEvaluationError });
      }

      const { decision } = outcome;
      if (decision.action === 'skip') {
        skipped++;
        if (decision.kind === 'rhythm') {
          skippedByRhythm.push({ userId: user.id, reason: decision.reason });
        }
        continue;
      }

      try {
        await generateNowOrchestrator.generateNow({
          userId: user.id,
          ...(decision.sabbathSession ? { sabbathSession: true } : {}),
          // P7 (#326): the daily run is the one "scheduled, standard-slot"
          // caller, so it is the one place feedback steering applies —
          // generate-now/examen/invite/distress callers never set this.
          // A no-op unless the orchestrator was built with a
          // FeedbackSteering dep, and fail-open inside the orchestrator
          // regardless.
          applyFeedbackSteering: true,
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

  // POST /internal/dispatch-meetbot — H1c (#131): the callback that
  // actually dispatches an Attendee bot. Two transports POST it (Q6 #336):
  // the Cloud Tasks queue, scheduled for gap_start_at (the original H1c
  // path), and ImmediateTaskScheduler, which fire-and-forgets the same
  // POST at generation time when MEETBOT_IMMEDIATE_DISPATCH=1 (the demo
  // path — same call site, same body, only the transport differs; the two
  // are mutually exclusive at boot, see index.ts).
  // Same shared-secret auth as every other /internal/* route — both
  // transports are our own infrastructure calling ourselves, never a third
  // party, so reusing INTERNAL_API_TOKEN here is consistent with the
  // daily-run/examen/purge/reschedule-check routes above (unlike
  // routes/meetBotAudio.ts's MEETBOT_AUDIO_TOKEN, whose URL is sent to
  // Attendee, an actual third party).
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

    const mbd = deps.meetBotDispatch;
    let dispatchParams: MeetBotDispatchParams;
    if (mbd.mode === 'voice-agent') {
      // Voice-agent mode (Epic Q, #335): the capability handed to Attendee
      // is the devotional's EXISTING session token, carried in the Stage
      // URL — /stage/:token is one devotional's session, same UUID-token-
      // as-credential doctrine as /session/:token (docs/04). Read-only
      // lookup; never mint a second session here.
      const session = await mbd.sessions.findByDevotionalId(devotionalId);
      if (!session) {
        // Shouldn't happen for scheduled devotionals (sessions are created
        // at scheduling time), but the route must not 500 into a Cloud
        // Tasks retry loop over a permanently-absent row — same "this task
        // is complete, do not retry" posture as the consent refusal above.
        request.log.warn(
          { devotionalId, userId: decision.userId },
          'meetbot dispatch refused — no session row for devotional (voice-agent mode, #335)',
        );
        return { ok: true, dispatched: false, reason: 'no_session' };
      }
      // Log discipline: the Stage URL contains a live session token — like
      // the meeting URL it must never be logged; the devotionalId above is
      // the auditable identifier.
      const stageUrl = stageUrlFor(mbd.publicBaseUrl, session.token);
      dispatchParams = { mode: 'voice-agent', meetingUrl, botName: botName ?? 'Wellspring', stageUrl };
    } else {
      // Mint a capability scoped to THIS devotional (#221). What we hand
      // Attendee is now a URL that authorizes streaming one devotional —
      // this one — rather than a URL containing a global secret that would
      // authorize streaming anyone's. See
      // services/meetBot/meetBotAudioCapabilityToken.ts.
      const audioToken = deriveMeetBotAudioToken(mbd.audioTokenSecret, devotionalId);
      const audioWebsocketUrl = `${mbd.audioWebsocketBaseUrl}/${audioToken}/${devotionalId}`;
      dispatchParams = { mode: 'websocket', meetingUrl, botName: botName ?? 'Wellspring', audioWebsocketUrl };
    }

    const result = await runMeetBotDispatch(dispatchParams, {
      attendeeClient: mbd.attendeeClient,
    });
    request.log.info({ devotionalId, userId: decision.userId, result }, 'meetbot dispatch completed');
    return { ok: result.ok, dispatched: true, result };
  });
}
