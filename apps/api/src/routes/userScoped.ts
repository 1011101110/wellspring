/**
 * Authenticated, user-scoped API surface (EPIC F, issue #42; extended by
 * issue #72 to the full documented shape, docs/03 §8.1).
 *
 * Every mutating body is Zod-validated against a shared-contracts schema
 * (docs/14 §2.9: "PUT /v1/preferences has zero Zod validation... zod
 * imported nowhere in apps/api/src, violating Foundation §11") and every
 * `:id`/`:date`/`:token` path param is shape-checked (UUID / ISO date)
 * before it reaches a repository query — an unvalidated string hitting a
 * `uuid`/`date`-typed column throws a pg cast error that only the global
 * error handler (app.ts) would otherwise catch as a generic 500. Routes
 * remain deliberately thin: `requireAuth` -> validate -> repository call
 * scoped by `request.auth.userId` -> 404 (never 403) when the resource
 * does not belong to that verified user, per Foundation §10 / docs/04
 * §5.4 ("never leak existence" — a resource owned by someone else must
 * look identical to a resource that never existed).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BandsUploadRequestSchema,
  CreateJournalEntryRequestSchema,
  GenerateNowRequestSchema,
  IsoDateParamSchema,
  MonthParamSchema,
  PreferencesUpdateRequestSchema,
  UuidParamSchema,
  YearParamSchema,
  DEFAULT_LANGUAGE,
  activeDaysForCadence,
  cadenceForActiveDays,
  defaultVersionIdFor,
  isVersionInLanguage,
  type BandsUploadResponseData,
  type DevotionalCard,
  type JournalEntry,
  type PreferencesResponseData,
  type UpcomingCalendarEvent,
} from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { Repositories } from '../db/repositories/index.js';
import type { DailyBandsRow } from '../db/repositories/dailyBandsRepository.js';
import type {
  DevotionalCardCursor,
  DevotionalCardRow,
} from '../db/repositories/devotionalsRepository.js';
import type { UpcomingCalendarEventRow } from '../db/repositories/calendarEventsRepository.js';
import type { PreferencesRow } from '../db/repositories/preferencesRepository.js';
import type { AudioStorage } from '../services/audio/audioStorage.js';
import { hardDeleteAccount } from '../services/retention/purgeJobs.js';
import { composeRhythm } from '../services/rhythm/rhythmSummary.js';
import {
  getLiturgicalSeason,
  liturgicalSeasonInformsGeneration,
} from '../services/gloo/liturgicalCalendar.js';
import { DEFAULT_TRADITION } from '../services/orchestrator/generateNowOrchestrator.js';
import type { RevokeGoogleConnectionDeps } from '../services/calendar/revokeGoogleConnection.js';
import {
  AlreadyExistsError,
  type GenerateNowOrchestrator,
} from '../services/orchestrator/generateNowOrchestrator.js';
import { generateInviteRoutingAddress } from '../services/invite/inviteRoutingAddress.js';
import { buildMonthlyRecap } from '../services/recap/monthlyRecapService.js';

/**
 * Maps the raw (snake_case) `daily_bands` row to the camelCased wire
 * contract every `/v1/bands` route promises (`BandsUploadResponseDataSchema`,
 * issue #83 — the routes previously returned the repository row directly,
 * which drifted from the schema silently since nothing validated the
 * response shape against it).
 */
function toBandsResponseData(row: DailyBandsRow): BandsUploadResponseData {
  return {
    date: row.date,
    recovery: row.recovery,
    sleepQuality: row.sleep_quality,
    activity: row.activity,
    busyness: row.busyness,
    communicationLoad: row.communication_load,
    distressSignal: row.distress_signal,
  };
}

/**
 * Same fix as `toBandsResponseData`, for `PreferencesResponseDataSchema` (issue #83).
 *
 * `onboardedAt` is passed in separately rather than read off `row` because
 * it is not a `preferences` column — it lives on `users` (migration
 * 1721800000000, issue #225). See the field's doc in shared-contracts for
 * why it is served from this endpoint at all. `timezone` (#187/#246),
 * `language` and `translationId` (#314) are the same story — `users`
 * columns riding the payload both clients already fetch.
 */
function toPreferencesResponseData(
  row: PreferencesRow,
  onboardedAt: Date | null,
  timezone: string,
  language: string,
  translationId: number,
  inviteEmailDomain: string | undefined,
): PreferencesResponseData {
  return {
    userId: row.user_id,
    windowStartLocal: row.window_start_local,
    windowEndLocal: row.window_end_local,
    activeDays: row.active_days,
    cadence: row.cadence,
    durationPreference: row.duration_preference,
    voice: row.voice,
    stillness: row.stillness,
    lectio: row.lectio,
    calendarEnabled: row.calendar_enabled,
    healthEnabled: row.health_enabled,
    communicationEnabled: row.communication_enabled,
    notifyOnSkip: row.notify_on_skip,
    examenEnabled: row.examen_enabled,
    sabbathDay: row.sabbath_day,
    sabbathEnabled: row.sabbath_enabled,
    sabbathSession: row.sabbath_session,
    liturgicalSeasonsEnabled: row.liturgical_seasons_enabled,
    // Adaptive rhythm (P5 #324): the user-owned pair round-trips; the
    // engine's `adaptive_*` state stays off the wire until P8 composes
    // §9-safe copy over it (#327).
    minPerWeek: row.min_per_week,
    adaptiveEnabled: row.adaptive_enabled,
    // P8 (#327): the server-composed rhythm summary — the engine's last
    // stored decision folded with the user's own bounds into the strict
    // (closed-shape, §9-safe) `Rhythm` contract. Composed on both GET and
    // PUT because both return this payload: a toggle of `adaptiveEnabled`
    // must come back already re-captioned (`fixed_by_user`), so the card
    // can re-render from the response rather than from local state.
    rhythm: composeRhythm(row),
    onboardedAt: onboardedAt ? onboardedAt.toISOString() : null,
    timezone,
    language,
    translationId,
    // L3 (#239): the user's invite routing address, minted by the SAME
    // helper `routes/inboundInvite.ts` parses with
    // (`generateInviteRoutingAddress` / `parseInviteRoutingAddress`, one
    // module) — so what we hand a user to paste into a calendar invite and
    // what the inbound parser will accept back cannot drift apart. A
    // hand-rolled template string here would be a second, silent
    // definition of the address scheme.
    //
    // Spread-conditional so the key is genuinely ABSENT (not `undefined`,
    // which JSON.stringify drops anyway, and not `''`) when no domain is
    // configured — see the field's doc in shared-contracts for why
    // absence is the only honest encoding of "there is no address".
    ...(inviteEmailDomain
      ? { inviteAddress: generateInviteRoutingAddress(row.user_id, inviteEmailDomain) }
      : {}),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface UserScopedRoutesDeps {
  repositories: Repositories;
  /** Needed so DELETE /v1/account can also remove the user's audio files, not just DB rows (issue #44 contract). */
  audioStorage: AudioStorage;
  /**
   * Wires Google token revocation into DELETE /v1/account (issue #81).
   * Optional because it's only constructible when Google OAuth env vars
   * are configured (same condition as ConnectRoutesDeps, app.ts) — a
   * deployment without Calendar integration configured simply has no
   * connections to revoke, so omitting this here is not a silent gap.
   */
  oauth?: RevokeGoogleConnectionDeps;
  /**
   * Powers POST /v1/devotional/generate-now (distress check-in front door,
   * issue #77). Optional like `oauth` above — omitted, the route returns
   * 501 rather than preventing every other user-scoped route from
   * registering.
   */
  generateNowOrchestrator?: GenerateNowOrchestrator;
  /**
   * `INVITE_EMAIL_DOMAIN` — the domain half of the user's invite routing
   * address, surfaced on `GET /v1/preferences` (L3, issue #239).
   *
   * Optional, and its absence is a supported production state rather than
   * a misconfiguration: this is a ⚠️ must-confirm value (Foundation §11 —
   * see inviteRoutingAddress.ts), so a deploy that has not yet wired a
   * receiving domain simply omits the field and the clients hide the
   * card. Passing it in (rather than reading `process.env` here) keeps
   * this route module free of ambient environment reads, which is also
   * what lets the tests prove the absent case without mutating the
   * process environment.
   */
  inviteEmailDomain?: string;
  /**
   * Injectable clock, for the upcoming-schedule cutoff (L4, issue #240).
   * Same rationale as `GenerateNowOrchestratorDeps.now`: "which events are
   * still in the future" is the entire behavior of that route, and a test
   * that cannot control now can only assert it called the repository —
   * which per #193 is not evidence of anything.
   */
  now?: () => Date;
  /**
   * Per-user rate limit for `POST /v1/devotional/generate-now` (L2, issue
   * #238). Defaults to `DEFAULT_GENERATE_NOW_RATE_LIMIT` below.
   *
   * Overridable for exactly the reason `sessionRateLimit`/`apiRateLimit`
   * already are in app.ts: proving the limiter *stops the work* requires
   * driving it past its threshold, and a test that has to fire the
   * production allowance to do so is slow, brittle, and tests the number
   * rather than the behavior.
   */
  generateNowRateLimit?: { max: number; timeWindowMs: number };
}

/**
 * Five generations per five minutes, per user (#238).
 *
 * Sized against what the button means rather than against server load. A
 * human pressing "+" wants one devotional; five inside five minutes is
 * already far past any deliberate use and squarely into "the client is
 * retrying". The cost of being wrong is asymmetric and one-directional:
 * a limit set too high is a bill (each press is a paid Gloo completion
 * plus a Cloud TTS synthesis), while a limit set too low costs a user a
 * 429 on a button they can press again shortly. It is also generous
 * enough that the distress path — which shares this route and must never
 * be the thing that tells someone reaching for help to wait — is not
 * realistically reachable by a person in genuine need.
 */
const DEFAULT_GENERATE_NOW_RATE_LIMIT = { max: 5, timeWindowMs: 5 * 60 * 1000 };

/**
 * How many upcoming events `GET /v1/calendar-events/upcoming` will return.
 * A hard cap rather than a client-supplied page size: this is a dashboard
 * card, not an archive (that is `GET /v1/devotionals`, which does paginate
 * — #241). Wellspring books at most one devotional per active day, so 50 is
 * roughly ten weeks out — past any horizon a user is meaningfully
 * planning against, and small enough that the response can never become a
 * payload problem the way the unbounded devotional list did.
 */
const UPCOMING_EVENTS_LIMIT = 50;

/**
 * Default and maximum page size for `GET /v1/devotionals` (#241).
 *
 * The max exists because `?limit=` is caller-controlled: without it, a
 * client (or a scraper holding one valid token) asks for `limit=100000`
 * and reinstates precisely the unbounded query this story removed. Out-of-
 * range values are clamped rather than 400'd — a client asking for more
 * than we will give is not malformed, it is optimistic, and the honest
 * answer is a full page plus a cursor rather than an error.
 */
const DEVOTIONAL_PAGE_SIZE_DEFAULT = 30;
const DEVOTIONAL_PAGE_SIZE_MAX = 100;

const DevotionalListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});

/**
 * The list cursor is **opaque by contract** (see `DevotionalListResponse`
 * in shared-contracts): base64url of the sort-key tuple. Opaque, not
 * because the contents are sensitive — a user's own devotional date and
 * id are not — but so that changing the pagination key later (adding a
 * tiebreaker, switching sort order) does not require a client release.
 * A client that parsed a readable cursor would couple itself to this
 * server's ordering internals.
 *
 * `decodeCursor` returns `null` for anything it cannot read, and the route
 * treats that as "start from the beginning" rather than 400ing. A cursor
 * is not user input in the meaningful sense — it is a value we handed the
 * client — so a corrupted one is our problem or a stale client's, and the
 * useful behavior is to serve page one rather than to fail the whole
 * screen. Nothing is trusted out of it regardless: the decoded values only
 * ever reach the query as bound `date`/`timestamptz`/`uuid` parameters
 * (which reject garbage at the cast), and the query is still scoped
 * `WHERE user_id = $1` from the verified token — so a forged cursor cannot
 * reach another user's rows, only a different position in the caller's own
 * list.
 */
function encodeCursor(row: DevotionalCardRow): string {
  const payload = JSON.stringify({
    d: row.date,
    c: row.created_at.toISOString(),
    i: row.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): DevotionalCardCursor | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const shape = z
      .object({ d: z.string(), c: z.string(), i: z.string().uuid() })
      .safeParse(parsed);
    if (!shape.success) return null;
    const createdAt = new Date(shape.data.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { date: shape.data.d, createdAt, id: shape.data.i };
  } catch {
    return null;
  }
}

/** Repository row -> wire card (#241). The body-shaped columns are absent from the row itself, so this cannot accidentally leak one. */
function toDevotionalCard(row: DevotionalCardRow): DevotionalCard {
  return {
    id: row.id,
    date: row.date,
    theme: row.theme,
    cardSummary: row.card_summary,
    format: row.format,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

/** Repository row -> wire shape for the upcoming schedule (#240). */
function toUpcomingCalendarEvent(row: UpcomingCalendarEventRow): UpcomingCalendarEvent {
  return {
    id: row.id,
    // ISO-8601 UTC instants. The client, not the server, applies the
    // user's zone (#240/#205) — the server has no business guessing which
    // zone to format in, and a pre-formatted local string would be
    // unparseable back into an instant.
    gapStartAt: row.gap_start_at.toISOString(),
    gapEndAt: row.gap_end_at.toISOString(),
    meetUri: row.meet_uri,
    rescheduleCount: row.reschedule_count,
    // The LEFT JOIN nulls all three devotional columns together; keying
    // the nested object off `devotional_id` (the FK that drove the join)
    // rather than off `theme` means a devotional row that somehow held an
    // empty theme still produces an object, not a silently dropped link.
    devotional:
      row.devotional_id !== null
        ? {
            id: row.devotional_id,
            theme: row.theme ?? '',
            cardSummary: row.card_summary ?? '',
          }
        : null,
  };
}

/** 404, never 403 — Foundation §10 / docs/04 §5.4: don't confirm existence of another user's resource. */
function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Not found', retryable: false },
  });
}

/**
 * Same 404 body as `notFound` — used for a param that fails shape
 * validation (non-UUID `:id`, non-ISO-date `:date`). A malformed id and a
 * well-formed-but-nonexistent id must be indistinguishable to the caller
 * (docs/04 §5.4), so this is not a 400: a 400 here would let a caller
 * distinguish "this id is shaped wrong" from "this id doesn't exist,"
 * which leaks more than we want on an authenticated-but-still-IDOR-prone
 * surface. (The PUBLIC /session/:token route, session.ts, applies the
 * identical principle — see its own comment for the enumeration-safety
 * angle in full.)
 */
function invalidParam(reply: FastifyReply) {
  return notFound(reply);
}

/** Validates a Zod schema against a request body; on failure, replies 400 with a generic message (never echoes raw input or Zod's issue paths). */
function badRequest(reply: FastifyReply, message = 'Invalid request body') {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

export function registerUserScopedRoutes(app: FastifyInstance, deps: UserScopedRoutesDeps): void {
  const { repositories } = deps;

  // --- preferences (1:1 with user) ---------------------------------------
  // docs/14_IMPROVEMENT_REVIEW.md §3.5 / issue #89: a brand-new
  // authenticated user (provisioned by requireAuth, but with no preferences
  // row yet — that row is only created lazily, on first PUT) should see the
  // documented column defaults, not a 404 — a fresh sign-in errored on the
  // very first preferences fetch. `ensureExists` is the same
  // upsert-then-return-row helper PUT already uses, so GET and PUT agree on
  // exactly what "the defaults" are (the DB column defaults, not a second,
  // hand-maintained copy in this file that could drift from them).
  //
  // Issue #225: this route is also the *read* side of server-authoritative
  // onboarding completion. `users.onboarded_at` is fetched alongside the
  // preferences row and returned in the same payload, deliberately in
  // preference to a separate `/v1/me`:
  //
  //  - Every client already calls this on sign-in and on foreground, so
  //    the cross-surface state arrives for free on a request that was
  //    happening anyway.
  //  - Two endpoints means two failures. The single most important
  //    behavior in #225 is that a failed fetch must never be read as "not
  //    onboarded"; splitting the read in half creates a partial-success
  //    state (preferences arrived, completion did not) where a client has
  //    to get that inference right a second time, in a code path that
  //    almost never executes and therefore almost never gets tested.
  //
  // `requireAuth` provisioned this user, so `findById` cannot miss — but
  // it is still handled rather than asserted, since a `null` here would
  // otherwise throw and turn a preferences fetch into a 500 over a field
  // that is allowed to be absent anyway.
  app.get('/v1/preferences', { preHandler: requireAuth }, async (request) => {
    const prefs = await repositories.preferences.ensureExists(request.auth!.userId);
    const user = await repositories.users.findById(request.auth!.userId);
    return {
      ok: true,
      data: toPreferencesResponseData(
        prefs,
        user?.onboarded_at ?? null,
        user?.timezone ?? 'UTC',
        user?.language ?? DEFAULT_LANGUAGE,
        user?.translation_id ?? defaultVersionIdFor(DEFAULT_LANGUAGE),
        deps.inviteEmailDomain,
      ),
    };
  });

  /**
   * The liturgical season, on the wire for the first time (N10, #269).
   *
   * #269 describes this as surfacing a value the backend already has. The
   * computus did exist (`liturgicalCalendar.ts`, #95) but no response
   * carried it — so this route is the "small change" that story actually
   * needed, and the reason it is not a new field on `GET /v1/preferences`
   * is that `tradition` lives on `users` and is deliberately absent there.
   *
   * ## Two things this route is careful about
   *
   * **1. It answers `null` rather than a season when the season is not
   * shaping this user's devotionals.** The gate is
   * `liturgicalSeasonInformsGeneration` — the same predicate
   * `buildInstructions` uses to decide whether the season line goes into
   * the prompt, not a second copy of the rule. So the dashboard cannot say
   * "Wellspring is writing in Lent" to a user whose prompt has never heard of
   * Lent, which would be the #193/#213 confident-and-false shape.
   *
   * **2. The date is UTC, matching `todayIsoDate` in
   * generateNowOrchestrator.ts, not the user's zone.** That is not an
   * oversight and not laziness about time zones: the generator resolves
   * its `date` as `now().toISOString().slice(0, 10)`, and the season this
   * route reports must be the season the user's devotional was actually
   * written under. Using the profile zone here would be *more* correct in
   * the abstract and *less* true in practice — the two would disagree for
   * a few hours around a season boundary, and the dashboard would name a
   * season the prompt did not use. Test Plan §3.1 rule 6: a calendar day
   * and an instant are both `string`, and this one is chosen to match its
   * producer. If the generator ever becomes zone-aware, this must move
   * with it — hence the note rather than a silent duplication.
   */
  app.get('/v1/liturgical-season', { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    const user = await repositories.users.findById(userId);
    const prefs = await repositories.preferences.get(userId);
    const tradition = user?.tradition ?? DEFAULT_TRADITION;
    const informs = liturgicalSeasonInformsGeneration(
      tradition,
      prefs?.liturgical_seasons_enabled ?? false,
    );
    const date = new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      data: {
        // `week` from `getLiturgicalSeason` is dropped here on purpose —
        // see the note in shared-contracts' `api/liturgy.ts`: a week
        // number on this surface is a countdown to Easter, and Foundation
        // §9 forbids the shape whatever it is counting.
        season: informs ? getLiturgicalSeason(date).season : null,
      },
    };
  });

  app.put<{ Body: unknown }>('/v1/preferences', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = PreferencesUpdateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const b = parsed.data;

    // K2 (#188): reconcile `activeDays` and `cadence` before either
    // reaches the database, so the stored pair can never contradict
    // itself. `active_days` is the single source of truth the daily run
    // reads; `cadence` is a derived label over the same set (full
    // rationale on `cadenceForActiveDays` in shared-contracts).
    //
    // Three cases, in precedence order:
    //
    //  1. `activeDays` present — it wins outright, and `cadence` is
    //     recomputed from it. A client that sends a *contradicting*
    //     cadence (the stored default of every pre-#188 row is
    //     `cadence: 'daily'` next to `active_days: {1,2,3,4,5}`) does not
    //     get to store the contradiction: the days are the choice, the
    //     cadence is only its name. Silently correcting rather than 400ing
    //     is deliberate — the disagreement is this codebase's own legacy,
    //     not client error, and rejecting it would break every client
    //     round-tripping a row it faithfully read back from us.
    //  2. `cadence` present alone — it acts as a *preset* and writes the
    //     day set it stands for. `'custom'` expands to nothing (it means
    //     "the days I picked"), so it stores the label and leaves the
    //     existing days untouched.
    //  3. Neither — both stay `undefined`, and the repository's COALESCE
    //     leaves both columns alone.
    const cadencePreset = b.cadence !== undefined ? activeDaysForCadence(b.cadence) : undefined;
    const resolvedActiveDays = b.activeDays ?? cadencePreset;
    const resolvedCadence =
      resolvedActiveDays !== undefined ? cadenceForActiveDays(resolvedActiveDays) : b.cadence;

    // Full documented field set (docs/03 §8.1, docs/14 §3.5/§2.9) — every
    // column PreferencesRepository.update accepts, now Zod-validated
    // instead of the previous 4-field typeof-checked subset.
    const updates = {
      window_start_local: b.windowStartLocal,
      window_end_local: b.windowEndLocal,
      active_days: resolvedActiveDays,
      cadence: resolvedCadence,
      duration_preference: b.durationPreference,
      voice: b.voice,
      stillness: b.stillness,
      lectio: b.lectio,
      calendar_enabled: b.calendarEnabled,
      health_enabled: b.healthEnabled,
      communication_enabled: b.communicationEnabled,
      notify_on_skip: b.notifyOnSkip,
      examen_enabled: b.examenEnabled,
      sabbath_day: b.sabbathDay,
      sabbath_enabled: b.sabbathEnabled,
      sabbath_session: b.sabbathSession,
      liturgical_seasons_enabled: b.liturgicalSeasonsEnabled,
      // Adaptive rhythm, user-owned half only (P5 #324). The engine's
      // state columns (`adaptive_days_per_week`/`adaptive_reason`/
      // `adaptive_decided_at`) are deliberately absent from this map, are
      // stripped from the body by the schema, and are unnameable on
      // `PreferencesUpdate` — a client cannot move the engine's ladder
      // position or reset its rate limiter through this route.
      min_per_week: b.minPerWeek,
      adaptive_enabled: b.adaptiveEnabled,
    };

    // `language`/`translationId` (#314, Epic O #311): two more fields that
    // aren't `preferences` columns — they write `users.language` /
    // `users.translation_id` through `updateProfile`, giving the
    // translation column its first-ever write path (until now web rendered
    // it as a disabled select and iOS captured a choice it could never
    // push).
    //
    // The cross-field rule, same spirit as `cadence`↔`activeDays` above —
    // make the contradictory pair unrepresentable rather than storable:
    //
    //  1. A language *change* with no `translationId` — the translation
    //     *snaps* to the new language's default (`defaultVersionIdFor`).
    //     Picking Español and keeping an English Bible is not a state any
    //     user means; a client that wants a specific translation sends it
    //     explicitly. A `language` merely *re-asserted* unchanged snaps
    //     nothing — see the comment at the write below.
    //  2. Both — accepted only if the translation IS one of that
    //     language's verified versions; otherwise 400. Unlike the cadence
    //     case, silently correcting here would discard an explicit choice
    //     the user just made, so loud rejection is right (the disagreement
    //     is genuine client error, not this codebase's own legacy).
    //  3. `translationId` alone — validated against the *stored* language,
    //     which costs the pre-write `findById` below; skipped entirely
    //     when neither field is present, so every pre-#314 request shape
    //     pays nothing.
    //
    // This block runs BEFORE the timezone/onboarding side effects so the
    // 400 rejects the request wholesale — a body that failed validation
    // must not have half-applied (#314 acceptance: stored values
    // untouched on the 400 path).
    if (b.language !== undefined || b.translationId !== undefined) {
      const stored = await repositories.users.findById(request.auth!.userId);
      const effectiveLanguage = b.language ?? stored?.language ?? DEFAULT_LANGUAGE;
      if (b.translationId !== undefined && !isVersionInLanguage(effectiveLanguage, b.translationId)) {
        return badRequest(reply, `translationId is not a ${effectiveLanguage} translation`);
      }
      // The snap keys off a language CHANGE, not language *presence*. A
      // full-object PUT client (the normal web-form pattern, and what O5
      // will ship) re-sends `language` unchanged on every unrelated save;
      // if presence alone snapped, each such save would silently reset an
      // explicit alternate translation (say, WEBUS 206) back to the
      // default — the same clobber-by-faithful-round-trip failure the
      // cadence block above bends over backwards to avoid. Re-asserting
      // the stored language is a statement of no change, so it changes
      // nothing; an explicit `translationId` riding along still wins.
      const languageChanged = b.language !== undefined && b.language !== stored?.language;
      const profile = await repositories.users.updateProfile(request.auth!.userId, {
        language: b.language,
        translation_id:
          b.translationId ?? (languageChanged ? defaultVersionIdFor(b.language!) : undefined),
      });
      // requireAuth provisioned this user, so a null here (no row matched)
      // is the same cannot-legitimately-happen case as the preferences
      // update below — handled rather than asserted, for the same reason.
      if (!profile) return notFound(reply);
    }

    // `timezone` was the first field in this body that isn't a
    // `preferences` column — it writes `users.timezone` (issue #187). It
    // rides along on
    // this route because this is the first authenticated write a new user
    // makes, and #187 requires a real zone to land *before* any calendar
    // is connected: `users.timezone` defaults to `'UTC'`, and the first
    // real connected user got a devotional gap at 07:30 UTC — 3:30am
    // where they actually live.
    //
    // Best-effort, in the codebase's usual sense: the Zod schema already
    // rejected an invalid identifier with a 400 before we got here, so
    // the only failures left are database ones, and a user saving their
    // devotional window should not get an error because a side-car field
    // failed to write. The next sync (or the daily run's calendar
    // refresh) tries again.
    //
    // `'device'` is the lowest non-`default` rank, so this cannot
    // overwrite a calendar-derived zone or an explicit choice —
    // `adoptTimezone` enforces that, not this call site.
    //
    // TODO(#187): the settings-screen picker is a separate slice. When it
    // lands it needs its own door writing source `'user'` (and this
    // response should carry the effective zone back so the picker can
    // pre-fill with it) — do NOT extend this field to carry an explicit
    // choice, since a device sync and a deliberate pick must not share a
    // source.
    if (b.timezone) {
      try {
        await repositories.users.adoptTimezone(request.auth!.userId, b.timezone, 'device');
      } catch (err) {
        request.log.warn(
          { err, userId: request.auth!.userId },
          'preferences: could not persist device time zone — keeping stored value',
        );
      }
    }

    // `onboardingCompleted` is the second field in this body that isn't a
    // `preferences` column (issue #225) — it writes `users.onboarded_at`,
    // exactly like `timezone` above writes `users.timezone`, and rides
    // this route for the identical reason.
    //
    // Unlike `timezone`, this one is NOT best-effort. A dropped time zone
    // costs a mistimed devotional that the next sync corrects; a dropped
    // onboarding mark leaves the user's "I finished" claim unrecorded on
    // the only surface both clients can see, and the client that just
    // completed onboarding will have moved on to the tab shell believing
    // it landed. So a failure here fails the request: the client sees a
    // 5xx, keeps its local latch, and retries on the next sync — which is
    // the behavior that actually converges. Swallowing it would produce
    // the silent, self-healing-looking gap that #193 is about.
    //
    // `markOnboarded` is first-write-wins, so re-sending this is inert
    // rather than a clock-bump; see its doc comment.
    if (b.onboardingCompleted) {
      await repositories.users.markOnboarded(request.auth!.userId);
    }

    await repositories.preferences.ensureExists(request.auth!.userId);
    const updated = await repositories.preferences.update(request.auth!.userId, updates);
    // ensureExists just guaranteed a row for this user, so `update`
    // (same WHERE user_id = $1) cannot legitimately return null here.
    if (!updated) return notFound(reply);

    // Re-read rather than reuse `markOnboarded`'s return: that returns
    // `null` in the steady state ("already onboarded"), which is precisely
    // the case where the response must still carry a real timestamp. This
    // read is also what lets a PUT that never touched onboarding echo the
    // stored value back, so PUT and GET return the same shape and a client
    // can apply either response identically.
    const user = await repositories.users.findById(request.auth!.userId);
    return {
      ok: true,
      data: toPreferencesResponseData(
        updated,
        user?.onboarded_at ?? null,
        user?.timezone ?? 'UTC',
        user?.language ?? DEFAULT_LANGUAGE,
        user?.translation_id ?? defaultVersionIdFor(DEFAULT_LANGUAGE),
        deps.inviteEmailDomain,
      ),
    };
  });

  // --- daily_bands ---------------------------------------------------------
  app.post<{ Body: unknown }>('/v1/bands', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = BandsUploadRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const b = parsed.data;
    const row = await repositories.dailyBands.upsertForDate(request.auth!.userId, {
      date: b.date,
      // Omitted health bands (issue #70's consent/no-data path) arrive
      // here as `undefined` from Zod's `.optional()` — upsertForDate's
      // own `?? null` already turns that into a stored SQL NULL, so no
      // extra translation is needed at this call site.
      recovery: b.recovery,
      sleepQuality: b.sleepQuality,
      activity: b.activity,
      busyness: b.busyness,
      communicationLoad: b.communicationLoad,
      distressSignal: b.distressSignal,
    });
    return { ok: true, data: toBandsResponseData(row) };
  });

  app.get<{ Params: { date: string } }>(
    '/v1/bands/:date',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!IsoDateParamSchema.safeParse(request.params.date).success) return invalidParam(reply);
      const row = await repositories.dailyBands.getForDate(
        request.auth!.userId,
        request.params.date,
      );
      if (!row) return notFound(reply);
      return { ok: true, data: toBandsResponseData(row) };
    },
  );

  app.get('/v1/bands', { preHandler: requireAuth }, async (request) => {
    const rows = await repositories.dailyBands.listRecent(request.auth!.userId);
    return { ok: true, data: rows.map(toBandsResponseData) };
  });

  // Server's own record of today's daily_bands row (issue #85) — makes the
  // iOS "data ledger" (docs/05 §3.1) verifiable against what the backend
  // actually received, not just what the client claims it sent. `null` data
  // is the normal "nothing uploaded yet today" state, not an error.
  app.get('/v1/ledger/today', { preHandler: requireAuth }, async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    const row = await repositories.dailyBands.getForDate(request.auth!.userId, today);
    const prayerIntentionRow = await repositories.prayerIntentions.getForDate(request.auth!.userId, today);
    return {
      ok: true,
      data: row ? toBandsResponseData(row) : null,
      prayerIntention: prayerIntentionRow
        ? { text: prayerIntentionRow.text, createdAt: prayerIntentionRow.created_at.toISOString() }
        : null,
    };
  });

  // --- devotionals -----------------------------------------------------
  // L5 (#241): cursor-paginated, newest first, card fields only.
  //
  // What this replaced: `listForUser(userId)` with no arguments — every
  // devotional the user has ever had, each as a full `SELECT *` row
  // including `devotional_body`. For a user a year into daily use that is
  // ~365 complete devotionals (bodies, prayers, verse arrays) shipped to
  // render a list of one-line themes. The archive screen is the one place
  // in the product where the payload grows without bound as the user
  // succeeds at using it, which is the worst possible place for it.
  //
  // Two independent changes, both required — either alone is insufficient:
  //
  //  1. **Projection** (`listCardsForUser`): bodies never enter the list
  //     response at all. Even a small page would otherwise carry them.
  //  2. **Pagination**: a cursor, not an offset. Offsets skip or repeat
  //     rows when a new devotional is created mid-scroll (and one is
  //     created every morning); a keyset cursor over the sort key cannot.
  //
  // `GET /v1/devotionals/:id` is untouched and remains the only way to
  // read a body — which is also what keeps this change off the replay/
  // audio path entirely.
  app.get<{ Querystring: unknown }>('/v1/devotionals', { preHandler: requireAuth }, async (request) => {
    // `.safeParse` with a fallback rather than a 400: every field here is
    // optional and a nonsense `?limit=banana` has an obvious, harmless
    // intended reading ("the first page"). Failing the archive screen over
    // a malformed query string would be a worse answer than serving it.
    const query = DevotionalListQuerySchema.safeParse(request.query ?? {});
    const requestedLimit = query.success ? query.data.limit : undefined;
    const limit = Math.min(requestedLimit ?? DEVOTIONAL_PAGE_SIZE_DEFAULT, DEVOTIONAL_PAGE_SIZE_MAX);
    const cursor = decodeCursor(query.success ? query.data.cursor : undefined);

    // Fetch one extra row: its existence is what proves there is a next
    // page. The alternative — always returning a cursor and letting the
    // client discover the end by receiving an empty page — costs every
    // client one guaranteed-wasted round trip at the bottom of every list,
    // and makes "are there more?" unanswerable at render time.
    const rows = await repositories.devotionals.listCardsForUser(request.auth!.userId, {
      limit: limit + 1,
      cursor,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      ok: true,
      data: page.map(toDevotionalCard),
      // `null`, never an empty string — see the contract's note. `lastRow`
      // can only be undefined on an empty page, which by definition has no
      // next page.
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/devotionals/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!UuidParamSchema.safeParse(request.params.id).success) return invalidParam(reply);
      const row = await repositories.devotionals.getById(request.auth!.userId, request.params.id);
      if (!row) return notFound(reply);
      return { ok: true, data: row };
    },
  );

  // --- journal (N9, #268) -------------------------------------------------
  // A kept, user-owned place to write what one is carrying. Never sent to
  // the model (v1) — it is for the person, which also keeps the
  // prompt-injection surface closed. No route here returns a count: the
  // journal keeps words, it does not tally them (Foundation §9, ruling
  // #271).
  const JOURNAL_PAGE_SIZE = 20;

  const toJournalEntry = (row: {
    id: string;
    text: string;
    created_at: Date;
  }): JournalEntry => ({
    id: row.id,
    text: row.text,
    createdAt: row.created_at.toISOString(),
  });

  app.post<{ Body: unknown }>('/v1/journal', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateJournalEntryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // A real 400 here, unlike the devotionals-list query: an empty or
      // over-long entry is a genuine client error with no sensible
      // fallback reading — there is nothing to keep.
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid entry');
    }
    const row = await repositories.journal.create(request.auth!.userId, parsed.data.text);
    return reply.status(201).send({ ok: true, data: toJournalEntry(row) });
  });

  app.get<{ Querystring: { before?: string } }>(
    '/v1/journal',
    { preHandler: requireAuth },
    async (request) => {
      // `before` is a plain ISO instant cursor (the previous page's oldest
      // `createdAt`), not an opaque encoded token: the journal list is
      // ordered by one column and there is nothing to hide in the cursor,
      // so an unparseable value just means "the first page" rather than a
      // 400 that would blank the journal over a bad query string.
      const beforeRaw = request.query?.before;
      const before = beforeRaw ? new Date(beforeRaw) : undefined;
      const cursor = before && !Number.isNaN(before.getTime()) ? before : undefined;

      const { entries, hasMore } = await repositories.journal.list(
        request.auth!.userId,
        JOURNAL_PAGE_SIZE,
        cursor,
      );
      const last = entries[entries.length - 1];
      return {
        ok: true,
        data: entries.map(toJournalEntry),
        nextCursor: hasMore && last ? last.created_at.toISOString() : null,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/journal/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!UuidParamSchema.safeParse(request.params.id).success) return invalidParam(reply);
      const removed = await repositories.journal.deleteOne(request.auth!.userId, request.params.id);
      // 404 for an id that is not the caller's (or does not exist) — the
      // two are deliberately indistinguishable (§5.4, never leak
      // existence), and both correctly deleted nothing.
      if (!removed) return notFound(reply);
      return { ok: true };
    },
  );

  // --- generate now (distress check-in #77 + dashboard "+" #238) ---------
  //
  // ## Two callers, one endpoint, one orchestrator
  //
  // `mode: 'distress'` (the default, and every shipped client's behavior)
  // is the original "I could use a moment now" check-in, docs/14 §5.8 /
  // issue #77: distressSignal forced true, the daily idempotency guard
  // bypassed (someone reaching for that button should always get a fresh
  // session, even if today's devotional already exists), calendar skipped.
  //
  // `mode: 'now'` (L2, issue #238) is the dashboard "+" button. Same
  // pipeline, three different flags — see `GenerateNowRequestSchema` in
  // shared-contracts for why this is a mode rather than a second route.
  //
  // Both return the same session-summary shape as POST
  // /internal/generate-now, so a client can open the session without a
  // second round trip.
  //
  // ## Rate limit (#238 requirement 3)
  //
  // Per-route and per-USER, tighter than the `/v1` scope's shared limit.
  // Every press of this button is a paid Gloo completion plus a Cloud TTS
  // synthesis — the only route on this surface where a retry loop in a
  // client turns directly into money. The `/v1` scope limit does not cover
  // this case: it is IP-keyed and sized for ordinary API chatter, so a
  // client stuck retrying generation stays comfortably under it while
  // billing us for every attempt.
  //
  // Keyed on `request.auth.userId`, not IP: the cost is incurred per user
  // (it is their devotional that gets generated), and IP-keying would
  // both let one user multiply their spend across networks and let a
  // shared corporate NAT starve colleagues of each other's allowance.
  // Falling back to `request.ip` covers the unauthenticated case — the
  // rate-limit hook runs before `requireAuth`'s 401, so an anonymous
  // flood still gets limited rather than sharing one null key.
  //
  // This works because `registerAuth` (auth/middleware.ts) populates
  // `request.auth` in an `onRequest` hook on the ROOT instance, which
  // Fastify runs before this child scope's own onRequest hooks — so the
  // verified userId is already on the request by the time the limiter
  // reads it, even though `requireAuth` itself is a later preHandler.
  app.post<{ Body: unknown }>(
    '/v1/devotional/generate-now',
    {
      preHandler: requireAuth,
      config: {
        rateLimit: {
          max: (deps.generateNowRateLimit ?? DEFAULT_GENERATE_NOW_RATE_LIMIT).max,
          timeWindow: (deps.generateNowRateLimit ?? DEFAULT_GENERATE_NOW_RATE_LIMIT).timeWindowMs,
          keyGenerator: (request) => request.auth?.userId ?? request.ip,
        },
      },
    },
    async (request, reply) => {
    if (!deps.generateNowOrchestrator) {
      return reply.status(501).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'generateNowOrchestrator not wired for this route', retryable: false },
      });
    }

    const parsed = GenerateNowRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const mode = parsed.data.mode;
    const isDistress = mode === 'distress';

    try {
      const result = await deps.generateNowOrchestrator.generateNow({
        userId: request.auth!.userId,
        // Distress: unchanged from #77 — `distressSignal: false` in the
        // body is the one way to opt that path out of forcing the signal.
        // "Now": never forces it. A routine "+" tap is not a crisis, and
        // treating it as one would hand the user a `micro`, elevated-care
        // devotional with a resource pointer they did not ask for. The
        // body's `distressSignal` is deliberately ignored here rather than
        // honored — this mode's whole purpose is to be the non-distress
        // door, so accepting a wire flag that reopens the distress framing
        // would defeat it (and #238: "distress path ... unreachable
        // from '+'").
        ...(isDistress ? { distressSignalOverride: parsed.data.distressSignal !== false } : {}),
        // Distress bypasses idempotency (always a fresh session). "Now"
        // does NOT: the second press of "+" on the same day must find
        // today's devotional rather than paying for a duplicate — see the
        // AlreadyExistsError handler below, which is the whole point of
        // letting the guard run.
        skipIdempotencyCheck: isDistress,
        // #238 requirement 5, and already true of the distress path: the
        // user is here, now. Booking a calendar meeting for the present
        // moment is noise on their calendar for an event they are already
        // attending. (The orchestrator also auto-skips the calendar step
        // whenever `distressSignalOverride` is set; passing it explicitly
        // means the "now" mode does not depend on that coincidence.)
        skipCalendar: true,
      });

      return {
        ok: true,
        sessionUrl: result.sessionUrl,
        devotionalId: result.devotionalId,
        // #238: the "+" needs to distinguish "I just made this" from "this
        // already existed" to pick its copy ("Today's devotional is ready
        // — open it"). Always present so the client branches on a value
        // rather than on the absence of a key.
        alreadyExisted: false,
        data: {
          sessionToken: result.sessionToken,
          source: result.source,
          audio: result.audio,
          devotional: result.devotional,
        },
      };
    } catch (err) {
      // ## Second press, same day (#238 requirement 2)
      //
      // The orchestrator signals same-day idempotency by THROWING
      // `AlreadyExistsError` — a control-flow signal, not a failure (the
      // daily-run fan-out in routes/internal.ts already treats it as a
      // skip rather than an error). For the "+" button the honest surface
      // is a SUCCESS carrying the existing session: the user asked for
      // today's devotional and today's devotional exists, so they get it.
      //
      // Explicitly not a 409. A 409 would be true to the HTTP semantics of
      // "you tried to create a duplicate" and false to the user's
      // intent — and it would land in the client as an error toast on a
      // button press that in fact succeeded, which is precisely the class
      // of lying UI Epic L's ground rule 1 exists to prevent. Nor is it a
      // silent regeneration: that would double the Gloo + TTS bill for a
      // second press and hand the user a *different* devotional than the
      // one they may already have started.
      //
      // Distress mode passes `skipIdempotencyCheck: true`, so it cannot
      // reach here — its behavior is untouched by this branch.
      if (err instanceof AlreadyExistsError) {
        // The error carries ids and a session URL but no devotional
        // content, so re-read the row for the theme/summary the client
        // needs to render the card it is about to open. Best-effort: a
        // failed read must not turn a successful "here is your
        // devotional" into an error, so the session link (the part that
        // actually matters) is returned either way.
        let devotional: { format: string; theme: string; cardSummary: string } | null = null;
        try {
          const row = await repositories.devotionals.getById(
            request.auth!.userId,
            err.devotionalId,
          );
          if (row) {
            devotional = {
              format: row.format,
              theme: row.theme,
              cardSummary: row.card_summary,
            };
          }
        } catch (readErr) {
          request.log.warn(
            { err: readErr, devotionalId: err.devotionalId },
            'generate-now: could not load the existing devotional summary — returning the session anyway',
          );
        }

        return {
          ok: true,
          sessionUrl: err.sessionUrl,
          devotionalId: err.devotionalId,
          alreadyExisted: true,
          data: {
            sessionToken: err.sessionToken,
            // `source`/`audio` describe an act of generation that did not
            // happen on this request. Reporting a fabricated 'gloo'/
            // 'uploaded' here would be a claim about work never done; the
            // client's job on this branch is to open the session, and
            // `sessionUrl` is what it opens.
            source: null,
            audio: null,
            devotional,
          },
        };
      }

      request.log.error({ err, mode }, 'generate-now failed');
      return reply.status(502).send({
        ok: false,
        error: { code: 'UPSTREAM_ERROR', message: 'Could not generate a session right now', retryable: true },
      });
    }
  });

  // --- sessions (authenticated "my sessions" list/detail — distinct from
  // the public unauthenticated /session/:token join surface) -------------
  app.get('/v1/sessions', { preHandler: requireAuth }, async (request) => {
    const rows = await repositories.sessions.listForUser(request.auth!.userId);
    return { ok: true, data: rows };
  });

  app.get<{ Params: { token: string } }>(
    '/v1/sessions/:token',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!UuidParamSchema.safeParse(request.params.token).success) return invalidParam(reply);
      const row = await repositories.sessions.findByToken(request.params.token);
      // findByToken is intentionally unscoped at the repository layer (it
      // backs the public join link) — this AUTHENTICATED route enforces
      // ownership itself before returning anything, so user B can never
      // read user A's session row via the authed API even though the
      // underlying repo method is a raw token lookup.
      if (!row || row.user_id !== request.auth!.userId) return notFound(reply);
      return { ok: true, data: row };
    },
  );

  // --- calendar_events ---------------------------------------------------
  // Unchanged (#240 deliberately does not touch it): raw rows, booking
  // order, everything. It has shipped consumers, and the upcoming view is
  // a different shape rather than a filtered version of this one — see
  // `UpcomingCalendarEventSchema` in shared-contracts for the full "why a
  // separate route rather than `?from=now`" argument.
  app.get('/v1/calendar-events', { preHandler: requireAuth }, async (request) => {
    const rows = await repositories.calendarEvents.listForUser(request.auth!.userId);
    return { ok: true, data: rows };
  });

  // L4 (#240): the upcoming schedule — what Wellspring has booked that hasn't
  // happened yet, soonest first, each joined to the theme and card summary
  // of the devotional it is for, with the Meet link and reschedule count.
  //
  // "Trust in an agent that books meetings comes from being able to
  // inspect what it booked" (#240) — which is only true if what it shows
  // is what is actually on the calendar. Hence the join carries the real
  // devotional theme rather than a generic label, and `rescheduleCount` is
  // surfaced rather than hidden: an event Wellspring has moved three times is
  // something the user is entitled to see it admit.
  //
  // The empty list is a REAL state, not an error (#240: weekends and
  // non-`active_days` produce genuinely empty schedules for default users,
  // #188). It is served as `{ ok: true, data: [] }` — a 200 with an empty
  // array — so a client cannot mistake "nothing scheduled" for "the
  // request failed". Explaining *why* it is empty is the client's job
  // (it holds the user's active days from `/v1/preferences`); the server
  // does not invent a reason string here, because a reason computed
  // server-side would be a second, drifting copy of the schedule logic.
  app.get('/v1/calendar-events/upcoming', { preHandler: requireAuth }, async (request) => {
    const now = deps.now ? deps.now() : new Date();
    const rows = await repositories.calendarEvents.listUpcomingForUser(
      request.auth!.userId,
      now,
      UPCOMING_EVENTS_LIMIT,
    );
    return { ok: true, data: rows.map(toUpcomingCalendarEvent) };
  });

  // --- monthly recap (docs/14 §5.9, issue #96) ----------------------------
  // Narrative, not numeric-first (§5.10 guardrail: no streaks/badges) —
  // built entirely from devotionals/sessions/daily_bands already held.
  app.get<{ Params: { year: string; month: string } }>(
    '/v1/recap/:year/:month',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!YearParamSchema.safeParse(request.params.year).success) return invalidParam(reply);
      if (!MonthParamSchema.safeParse(request.params.month).success) return invalidParam(reply);

      const year = Number(request.params.year);
      const month = Number(request.params.month);
      const data = await buildMonthlyRecap(
        {
          devotionals: repositories.devotionals,
          sessions: repositories.sessions,
          dailyBands: repositories.dailyBands,
        },
        request.auth!.userId,
        year,
        month,
      );
      return { ok: true, data };
    },
  );

  // --- account -------------------------------------------------------------
  app.delete('/v1/account', { preHandler: requireAuth }, async (request) => {
    await hardDeleteAccount(
      {
        devotionals: repositories.devotionals,
        users: repositories.users,
        audioStorage: deps.audioStorage,
        oauth: deps.oauth,
      },
      request.auth!.userId,
      request.log,
    );
    return { ok: true };
  });
}
