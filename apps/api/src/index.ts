import { buildApp } from './app.js';
import { closePool, getPool } from './db/pool.js';
import { asVerifiedUserId, createRepositories } from './db/repositories/index.js';
import { SessionService } from './services/session/sessionService.js';
import { buildAudioStorageFromEnv } from './services/audio/audioStorageConfig.js';
import { GlooTokenManager } from './services/gloo/glooTokenManager.js';
import { GlooResponsesClient } from './services/gloo/glooResponsesClient.js';
import { LoggingGlooSummaryService } from './services/gloo/glooSummaryService.js';
import { YouVersionClient } from './services/youversion/youVersionClient.js';
import { DevotionalEngine } from './services/devotionalEngine.js';
import { TtsService } from './services/tts/ttsService.js';
import { GenerateNowOrchestrator, NEUTRAL_DEFAULT_BANDS } from './services/orchestrator/generateNowOrchestrator.js';
import { buildEmailSenderFromEnv } from './services/invite/resendEmailSender.js';
import { HttpResendInboundEmailProvider } from './services/invite/inboundEmailProvider.js';
import { buildGoogleOAuthServiceFromEnv } from './services/calendar/googleOAuthService.js';
import { buildGoogleKmsServiceFromEnv } from './services/calendar/googleKmsService.js';
import { buildLiveKitConfigFromEnv } from './services/delivery/liveKitConfig.js';
import { LiveKitRoomProvider } from './services/delivery/liveKitRoomProvider.js';
import { MeetBotProvider } from './services/delivery/meetBotProvider.js';
import { GcpTaskScheduler } from './services/tasks/taskScheduler.js';
import {
  ImmediateTaskScheduler,
  assertMeetBotDispatchConfigExclusive,
} from './services/tasks/immediateTaskScheduler.js';
import { HttpAttendeeClient } from './services/meetBot/attendeeClient.js';
import { SessionFeedbackSignalSource } from './services/rhythm/sessionFeedbackSignalSource.js';
import { FeedbackSteering } from './services/rhythm/feedbackSteering.js';

/** Hard cap on graceful shutdown — docs/14 §2.6 / issue #73: "10s cap". */
const SHUTDOWN_CAP_MS = 10_000;

const port = Number(process.env.PORT) || 8080;
const host = '0.0.0.0';

/**
 * SessionService wiring: real Postgres pool (src/db/pool.ts) + AudioStorage.
 * AudioStorage selection (env var name, fail-closed signing-secret checks)
 * lives in services/audio/audioStorageConfig.ts (issue #68, docs/14
 * §1.1/§1.4) so it is unit-testable without booting the process.
 * `DATABASE_URL` (or `DB_SOCKET`) is required either way — see
 * db/pool.ts buildConfig() — so if neither is set this throws at startup
 * rather than serving a DB-less app silently.
 */
const pool = getPool();
const repositories = createRepositories(pool);
const { storage: audioStorage, description: audioStorageDescription } =
  buildAudioStorageFromEnv();
// F8 Gloo engagement summary (issue #86): the real Gloo ingestion endpoint
// is unconfirmed (tracked separately as issue #21), so only the logging
// no-op transport is wired here until that's resolved.
const glooSummaryService = new LoggingGlooSummaryService();
const sessionService = new SessionService({
  sessions: repositories.sessions,
  devotionals: repositories.devotionals,
  audioStorage,
  dailyBands: repositories.dailyBands,
  glooSummaryService,
  glooEngagementSummaries: repositories.glooEngagementSummaries,
  prayerIntentions: repositories.prayerIntentions,
  sessionFeedback: repositories.sessionFeedback,
});

/**
 * generate-now vertical slice wiring (issue #74, docs/14 §4.1). Real Gloo +
 * YouVersion + Cloud TTS clients — the same construction the LIVE test
 * (tests/services/orchestrator/generateNowOrchestrator.live.test.ts) proves
 * end-to-end. `GLOO_CLIENT_ID`/`GLOO_CLIENT_SECRET`/`YOUVERSION_API_KEY` are
 * already required secrets for this service (deploy-api.yml `--set-secrets`);
 * `GlooTokenManager` itself throws at construction if either Gloo value is
 * empty, so a misconfigured deploy fails fast at boot rather than on first
 * request.
 */
const glooTokenManager = new GlooTokenManager({
  clientId: process.env.GLOO_CLIENT_ID ?? '',
  clientSecret: process.env.GLOO_CLIENT_SECRET ?? '',
});
const glooResponsesClient = new GlooResponsesClient({
  getAccessToken: () => glooTokenManager.getToken(),
  // docs/14 §2.2: wire the designed re-mint-once-on-401 hook.
  invalidateToken: () => glooTokenManager.invalidate(),
});
const youVersionClient = new YouVersionClient({ apiKey: process.env.YOUVERSION_API_KEY ?? '' });
/**
 * `PROVIDERS=fixture` kill switch (docs/06 §6, docs/14 §4.4 / issue #91):
 * one env var, no code change, removes every live Gloo/YouVersion
 * dependency from devotional generation — Foundation §11 ("judging must
 * never depend on live APIs"). Clients above are still constructed (so a
 * misconfigured non-fixture deploy still fails fast on missing secrets),
 * they are simply never called when this is active.
 */
const forceFixture = process.env.PROVIDERS === 'fixture';
const devotionalEngine = new DevotionalEngine({ glooResponsesClient, youVersionClient, forceFixture });
const ttsService = new TtsService();

const { sender: emailSender, description: emailSenderDescription } = buildEmailSenderFromEnv();

// Google Calendar OAuth + KMS (issue #22). Both services throw at construction
// if required env vars are absent — fail-closed. When GOOGLE_OAUTH_CLIENT_ID /
// GOOGLE_OAUTH_CLIENT_SECRET / PUBLIC_BASE_URL are not set (e.g. a
// non-calendar deployment), connectRoutes is simply not passed to buildApp so
// those routes remain unregistered and the app boots normally. The OAuth
// `state` parameter itself is an opaque token backed by oauth_states (see
// routes/connect.ts) — no signing secret is required for it.
let connectRoutes: import('./app.js').BuildAppOptions['connectRoutes'] | undefined;
let orchestratorCalendarDeps: {
  calendarClient?: import('./services/calendar/googleCalendarClient.js').GoogleCalendarClient;
  kmsService?: import('./services/calendar/googleKmsService.js').GoogleKmsService;
} = {};

try {
  const oauthService = buildGoogleOAuthServiceFromEnv();
  const kmsService = buildGoogleKmsServiceFromEnv();
  const { GoogleCalendarClient } = await import('./services/calendar/googleCalendarClient.js');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const redirectUri = `${publicBaseUrl.replace(/\/$/, '')}/v1/connect/google/callback`;

  const calendarClient = new GoogleCalendarClient({
    // The per-user refresh token is injected per-call via withRefreshToken()
    // in the orchestrator; this factory-level getRefreshToken is a no-op
    // placeholder that should never be invoked at the factory level.
    getRefreshToken: () => Promise.reject(new Error('Use withRefreshToken() for per-user calls')),
    clientId,
    clientSecret,
    redirectUri,
  });

  connectRoutes = {
    oauthService,
    kmsService,
    connections: repositories.connections,
    users: repositories.users,
    oauthStates: repositories.oauthStates,
    // Turn calendar reading on when the OAuth grant completes (#299), so a
    // connected user is never stranded on a "reading is turned off" grid.
    preferences: repositories.preferences,
    // Where a browser-originated connect returns to (#195). Read here rather
    // than inside the handler so it is injectable in tests. Validated in
    // registerConnectRoutes — must be an https:// URL or the flow falls back
    // to the iOS custom scheme, so leaving this unset is safe.
    //
    // WEB_APP_BASE_URL is a comma-separated ALLOWLIST (it doubles as the CORS
    // origin list in app.ts, which splits it). The redirect base must be a
    // SINGLE origin — using the raw comma-joined value builds a malformed URL
    // (`https://a,https://b/connect/callback`) that a browser resolves to
    // about:blank after a web calendar connect. Take the first origin.
    webAppBaseUrl: process.env.WEB_APP_BASE_URL?.split(',')[0]?.trim() || undefined,
    // Adopt the connected calendar's IANA zone as the user's timezone so
    // "their morning" means their actual morning (see ConnectRoutesDeps).
    getCalendarTimeZone: (refreshToken: string) =>
      calendarClient.withRefreshToken(refreshToken).getCalendarTimeZone(),
  };

  orchestratorCalendarDeps = { calendarClient, kmsService };
} catch {
  // Google OAuth / KMS env vars not configured — skip calendar routes silently.
  // Prevents a misconfigured (non-calendar) deploy from crashing at boot.
}

/**
 * LiveKit delivery (D4/#32, docs/22 §2.1). Same fail-closed boot-skip
 * pattern as Google Calendar OAuth above: when LIVEKIT_URL/API_KEY/
 * API_SECRET aren't configured (true for every deploy so far — no
 * LiveKit Cloud account has been created yet), `deliveryProvider` stays
 * undefined and `GenerateNowOrchestrator` defaults to
 * `HostedSessionProvider` — byte-identical behavior to before this
 * feature existed. `roomRoutes`/`liveKitWebhookRoutes` are simply not
 * passed to buildApp() either, so /room/* and /livekit/webhook are not
 * registered at all.
 */
let roomRoutes: import('./app.js').BuildAppOptions['roomRoutes'] | undefined;
let liveKitWebhookRoutes: import('./app.js').BuildAppOptions['liveKitWebhookRoutes'] | undefined;
let deliveryProvider: import('./services/delivery/deliveryProvider.js').DeliveryProvider | undefined;

try {
  const liveKitConfig = buildLiveKitConfigFromEnv();
  deliveryProvider = new LiveKitRoomProvider(liveKitConfig.publicBaseUrl);
  roomRoutes = { sessionService, liveKitConfig };
  liveKitWebhookRoutes = { sessionService, liveKitConfig };
} catch {
  // LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured —
  // skip LiveKit delivery silently, same rationale as calendar OAuth above.
}

/**
 * routes/meetBotAudio.ts — the audio websocket Attendee connects to, and
 * the place that makes the bot LEAVE once the devotional has played once
 * (via attendeeClient). Gated on ATTENDEE_API_KEY, same fail-closed-by-
 * omission pattern as the LiveKit block above.
 */
let meetBotAudioRoutes: import('./app.js').BuildAppOptions['meetBotAudioRoutes'] | undefined;
if (process.env.ATTENDEE_API_KEY) {
  meetBotAudioRoutes = {
    audioStorage,
    attendeeClient: new HttpAttendeeClient(process.env.ATTENDEE_API_KEY),
    // Connect-time consent gate (#221). Same repositories, and the same
    // reasoning, as the dispatch gate wired below: this only READS
    // connection status out of our own database, so unlike
    // `rescheduleWatcher`/`getCalendarTimeZoneForUser` it is deliberately
    // NOT gated on live Calendar access — it must be present in every
    // deploy that can stream audio into a meeting, because its whole
    // purpose is to be the thing that says no.
    consentGate: {
      devotionals: repositories.devotionals,
      users: repositories.users,
      connections: repositories.connections,
    },
    // Durable play-once guard (#221) — replaces the process-local Set that
    // a Cloud Run cold start used to reset, letting a reconnect replay a
    // devotional that had already been spoken aloud.
    playbackLedger: repositories.devotionals,
  };
}

/**
 * Epic I (#60), issue #61 — gated on both RESEND_API_KEY and
 * INVITE_EMAIL_DOMAIN being present so it's simply absent from any deploy
 * that hasn't wired a Resend account + receiving domain yet (neither
 * exists as of 2026-07-07 — see docs/12 §1.4, docs/10 credentials list).
 */
let inboundInviteRoutes: import('./app.js').BuildAppOptions['inboundInviteRoutes'] | undefined;
if (process.env.RESEND_API_KEY && process.env.INVITE_EMAIL_DOMAIN) {
  inboundInviteRoutes = {
    inviteDomain: process.env.INVITE_EMAIL_DOMAIN,
    emailProvider: new HttpResendInboundEmailProvider(process.env.RESEND_API_KEY),
    users: repositories.users,
  };
}

/**
 * H1c (#131): MeetBotProvider + Cloud Tasks dispatch — gated behind its
 * own three env vars (MEETBOT_TASKS_PROJECT_ID/LOCATION/QUEUE), separate
 * from and in addition to ATTENDEE_API_KEY. The live `meetbot-dispatch`
 * Cloud Tasks queue was created 2026-07-07 and these vars were wired into
 * deploy-api.yml 2026-07-08 (owner ACTIVATED H1 for all Google-connected
 * users, accept+disclose transcription posture — Foundation §8, docs/22
 * §3). When all five vars are present, `deliveryProvider` becomes
 * `MeetBotProvider` (overriding LiveKit): Google-Calendar events carry a
 * real Meet link and a bot dispatches at gap_start_at. The gate remains
 * so a deploy without these vars (e.g. a fresh env) is still inert and
 * falls back to LiveKit/HostedSessionProvider.
 */
/**
 * Q6 (#336): `MEETBOT_IMMEDIATE_DISPATCH=1` — the demo dispatch path.
 * Same boolean-ish flag style as `PROVIDERS === 'fixture'` above. When
 * set (plus ATTENDEE_API_KEY + INTERNAL_API_TOKEN), the orchestrator's
 * `taskScheduler` is an `ImmediateTaskScheduler`: instead of enqueueing a
 * Cloud Task for `gap_start_at`, it fire-and-forgets an immediate POST to
 * our own /internal/dispatch-meetbot — same call site, same fire-time
 * consent gate, same log-and-continue posture; only the transport
 * changes. The exclusivity assert refuses to boot if the Cloud Tasks
 * config is ALSO set — both live at once would dispatch two bots per
 * devotional (the route is not idempotent).
 */
const meetBotImmediateDispatch = process.env.MEETBOT_IMMEDIATE_DISPATCH === '1';
assertMeetBotDispatchConfigExclusive(process.env);

let meetBotDispatchDeps: import('./services/orchestrator/generateNowOrchestrator.js').GenerateNowOrchestratorDeps['meetBotDispatch'];
if (process.env.MEETBOT_TASKS_PROJECT_ID && process.env.MEETBOT_TASKS_LOCATION && process.env.MEETBOT_TASKS_QUEUE && process.env.ATTENDEE_API_KEY && process.env.INTERNAL_API_TOKEN) {
  deliveryProvider = new MeetBotProvider(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  meetBotDispatchDeps = {
    taskScheduler: new GcpTaskScheduler({
      projectId: process.env.MEETBOT_TASKS_PROJECT_ID,
      location: process.env.MEETBOT_TASKS_LOCATION,
      queue: process.env.MEETBOT_TASKS_QUEUE,
    }),
    dispatchUrl: `${(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')}/internal/dispatch-meetbot`,
    internalApiToken: process.env.INTERNAL_API_TOKEN,
  };
} else if (meetBotImmediateDispatch && process.env.ATTENDEE_API_KEY && process.env.INTERNAL_API_TOKEN) {
  // (The else-if is belt-and-braces: the assert above already refuses to
  // boot when both configs are set.) MeetBotProvider is still what makes
  // the calendar step request a real Meet link (conferenceData) — without
  // it `inserted.meetUri` is never set and nothing would ever dispatch.
  deliveryProvider = new MeetBotProvider(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`);
  meetBotDispatchDeps = {
    taskScheduler: new ImmediateTaskScheduler({
      logger: {
        // pino-compatible signature; the app logger doesn't exist yet at
        // construction time, so route through console the way a boot-time
        // failure would be.
        info: (obj, msg) => console.log(msg, obj),
        error: (obj, msg) => console.error(msg, obj),
      },
    }),
    dispatchUrl: `${(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')}/internal/dispatch-meetbot`,
    internalApiToken: process.env.INTERNAL_API_TOKEN,
  };
}

const generateNowOrchestrator = new GenerateNowOrchestrator({
  users: repositories.users,
  preferences: repositories.preferences,
  dailyBands: repositories.dailyBands,
  devotionals: repositories.devotionals,
  sessions: repositories.sessions,
  devotionalEngine,
  ttsService,
  audioStorage,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
  prayerIntentions: repositories.prayerIntentions,
  // P7 (#326): feedback → generation params. Only the daily run opts in
  // (`applyFeedbackSteering` in routes/internal.ts), so wiring it here
  // changes nothing for generate-now/examen/invite/distress callers.
  feedbackSteering: new FeedbackSteering({
    feedback: repositories.sessionFeedback,
    devotionals: repositories.devotionals,
    preferences: repositories.preferences,
  }),
  // Calendar integration deps (only present when env vars are configured).
  ...orchestratorCalendarDeps,
  connections: orchestratorCalendarDeps.calendarClient ? repositories.connections : undefined,
  calendarEvents: orchestratorCalendarDeps.calendarClient ? repositories.calendarEvents : undefined,
  deliveryProvider,
  meetBotDispatch: meetBotDispatchDeps,
});

// I2 (#62): wire the inbound-invite route's generation hook to the shared
// orchestrator (constructed just above, so it can't be set at the route's
// own definition site). An invite generates with NEUTRAL_DEFAULT_BANDS
// (the organizer's health signals are not the subject — their written
// words are), no calendar step (the meeting already has its own time), and
// no idempotency guard (each invite is its own user-triggered generation,
// not the daily batch). The route only supplies inviteContext + duration.
if (inboundInviteRoutes) {
  inboundInviteRoutes.generateFromInvite = async ({ userId, inviteContext, durationPreference }) => {
    const result = await generateNowOrchestrator.generateNow({
      userId,
      bandsOverride: NEUTRAL_DEFAULT_BANDS,
      skipCalendar: true,
      skipIdempotencyCheck: true,
      inviteContext,
      durationPreferenceOverride: durationPreference ?? undefined,
    });
    return { sessionUrl: result.sessionUrl, devotionalId: result.devotionalId };
  };
}

const app = buildApp({
  sessionService,
  repositories,
  audioStorage,
  connectRoutes,
  // GET /v1/calendar/freebusy (M1, #255) — the dashboard calendar view's
  // live proxy. Gated on the same calendar env vars as everything else
  // here: with no `GoogleCalendarClient` there is no calendar to read, and
  // a route that could only ever 502 is worse than one that is absent.
  calendarFreeBusyRoutes: orchestratorCalendarDeps.calendarClient
    ? {
        preferences: repositories.preferences,
        connections: repositories.connections,
        users: repositories.users,
        kmsService: orchestratorCalendarDeps.kmsService!,
        calendarClient: orchestratorCalendarDeps.calendarClient,
      }
    : undefined,
  // GET /stage/:token (Q2 #332 / Q3 #333, epic #330) — the Stage page the
  // Attendee voice-agent loads into a Meet, and the standalone demo floor.
  // Wired whenever sessionService exists (same data source as /session);
  // uses the READ-ONLY getStageView so a bot container load never counts
  // as a join (Epic P attendance integrity).
  stageRoutes: { sessionService },
  roomRoutes,
  liveKitWebhookRoutes,
  meetBotAudioRoutes,
  inboundInviteRoutes,
  // POST /v1/devotional/generate-now (distress check-in, issue #77; the
  // dashboard "+" mode, issue #238) reuses the same orchestrator instance
  // as the /internal/* routes below.
  generateNowOrchestrator,
  // L3 (#239): surfaces `u_<userId>@<domain>` on GET /v1/preferences.
  //
  // Gated on the SAME condition as `inboundInviteRoutes` above, not on
  // INVITE_EMAIL_DOMAIN alone.
  //
  // #239 originally specified the domain alone, on the reasoning that the
  // domain is what makes an address well-formed while Resend is merely one
  // way of receiving mail at it. True in principle, wrong here: in this
  // deployment Resend IS the receiving mechanism, so a deploy with a domain
  // but no RESEND_API_KEY would render a real-looking address that nothing
  // is listening on. A user would copy it onto a calendar invite and get
  // silence.
  //
  // That is precisely the "control that lies" shape Epic L ground rule 1
  // forbids, and the same family as #213's disconnect button. The address
  // is only shown when something can actually receive at it — the gate
  // tracks the capability, not the string's syntax.
  inviteEmailDomain:
    process.env.RESEND_API_KEY && process.env.INVITE_EMAIL_DOMAIN
      ? process.env.INVITE_EMAIL_DOMAIN
      : undefined,
  internalRoutes: {
    generateNowOrchestrator,
    users: repositories.users,
    // Wires POST /internal/trigger-examen-run (issue #77) — fan-out target
    // for the evening examen Cloud Scheduler job.
    preferences: repositories.preferences,
    // Wires the adaptive-rhythm effective-days gate inside
    // /internal/trigger-daily-run (P6 #325, epic #312): P4's attendance
    // signal reads. Always present — both readers run against the same
    // pool as everything else — and the route fails open per user anyway
    // if either read breaks at runtime.
    rhythm: {
      sessions: repositories.sessions,
      feedback: new SessionFeedbackSignalSource(pool),
    },
    // Wires POST /internal/purge (issue #82) — the retention sweeps
    // (purgeJobs.ts) were implemented and tested but never invoked
    // anywhere; this plus the Cloud Scheduler job created alongside this
    // change is what actually runs them.
    purgeJobs: {
      dailyBands: repositories.dailyBands,
      devotionals: repositories.devotionals,
      sessions: repositories.sessions,
      users: repositories.users,
      audioStorage,
      prayerIntentions: repositories.prayerIntentions,
    },
    // Wires POST /internal/trigger-reschedule-check (issue #25) — only
    // present when calendar env vars are configured, same condition as
    // generateNowOrchestrator's own calendar step (orchestratorCalendarDeps
    // above). A deploy without Calendar integration configured simply has
    // no reschedule watcher to run, matching connectRoutes' own pattern.
    // Wires the daily-run time zone refresh and POST /internal/backfill-
    // timezones (K1, #187). Same connection -> decrypt -> withRefreshToken
    // chain `rescheduleWatcher` and the orchestrator's calendar step use,
    // collapsed to the one narrow callback those routes need. Gated on the
    // same calendar env vars as everything else here: without them there
    // is no zone to read, and the device zone (preferences sync) is the
    // only signal that deploy has.
    getCalendarTimeZoneForUser: orchestratorCalendarDeps.calendarClient
      ? async (userId: string) => {
          const connection = await repositories.connections.findByProvider(
            asVerifiedUserId(userId),
            'google_calendar',
          );
          if (!connection || connection.status !== 'active') return undefined;
          const refreshToken = await orchestratorCalendarDeps.kmsService!.decryptToken(
            connection.encrypted_refresh_token,
          );
          return orchestratorCalendarDeps
            .calendarClient!.withRefreshToken(refreshToken)
            .getCalendarTimeZone();
        }
      : undefined,
    rescheduleWatcher: orchestratorCalendarDeps.calendarClient
      ? {
          connections: repositories.connections,
          calendarEvents: repositories.calendarEvents,
          preferences: repositories.preferences,
          users: repositories.users,
          calendarClient: orchestratorCalendarDeps.calendarClient,
          kmsService: orchestratorCalendarDeps.kmsService!,
        }
      : undefined,
    // Wires POST /internal/dispatch-meetbot (H1c, #131) — only present
    // when ATTENDEE_API_KEY is configured.
    //
    // Mode selection (Epic Q, #335/#336): with MEETBOT_IMMEDIATE_DISPATCH
    // the route dispatches in voice-agent mode — bots load the Stage page
    // (`/stage/:token`, token resolved read-only from the devotional's
    // existing session) instead of connecting to the PCM websocket.
    // Without the flag, the websocket wiring below is byte-identical to
    // before #335/#336.
    meetBotDispatch: meetBotImmediateDispatch
      ? process.env.ATTENDEE_API_KEY
        ? {
            mode: 'voice-agent' as const,
            attendeeClient: new HttpAttendeeClient(process.env.ATTENDEE_API_KEY),
            sessions: repositories.sessions,
            // Same origin sessionUrl is derived from in the orchestrator.
            publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
            // Fire-time consent gate (#217) — identical wiring and
            // rationale as the websocket branch below; the gate is
            // mode-independent by design.
            consentGate: {
              devotionals: repositories.devotionals,
              users: repositories.users,
              connections: repositories.connections,
            },
          }
        : undefined
      : process.env.ATTENDEE_API_KEY && process.env.MEETBOT_AUDIO_TOKEN
        ? {
            attendeeClient: new HttpAttendeeClient(process.env.ATTENDEE_API_KEY),
            // No secret in this base URL any more (#221): the capability
            // token is derived per devotional at dispatch time from
            // `audioTokenSecret` below, and appended along with the id.
            audioWebsocketBaseUrl: `${(process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/^http/, 'ws')}/meetbot/audio`,
            audioTokenSecret: process.env.MEETBOT_AUDIO_TOKEN,
            // Fire-time consent gate (#217). Note these are the plain
            // repositories, NOT gated on `orchestratorCalendarDeps.calendarClient`
            // the way `rescheduleWatcher`/`getCalendarTimeZoneForUser` above
            // are. Those need live Calendar *access* to do their job, so
            // they are correctly absent without it. This gate only needs to
            // READ connection status out of our own database — and it must
            // be present in every deploy that can dispatch a bot, because
            // its whole purpose is to be the thing that says no.
            consentGate: {
              devotionals: repositories.devotionals,
              users: repositories.users,
              connections: repositories.connections,
            },
          }
        : undefined,
    // INTERNAL_API_TOKEN is in Secret Manager and wired into deploy-api.yml's
    // --set-secrets. Locally, set INTERNAL_API_TOKEN in .env; routes/internal.ts
    // fails closed (401 on every request) when it is unset, so omitting it
    // is safe, not silently insecure.
  },
});

app.log.info(`EmailSender selected: ${emailSenderDescription}`);

app.log.info(
  forceFixture
    ? 'PROVIDERS=fixture kill switch ACTIVE — devotional generation never calls Gloo/YouVersion'
    : 'PROVIDERS mode: live (default)',
);

// Boot-time log line stating which AudioStorage was selected (docs/14
// §1.1 fix) — logged AFTER app construction so it uses the same pino
// instance/format as the rest of the app's request logs.
app.log.info(`AudioStorage selected: ${audioStorageDescription}`);

// D4/#32, docs/23_LIVEKIT_DELIVERY.md §6: same boot-log convention as
// AudioStorage/EmailSender above — lets a Cloud Logging read confirm
// LiveKit delivery actually activated on THIS deploy, without needing a
// live room-join test just to answer "did the env vars take effect?".
app.log.info(
  deliveryProvider
    ? 'LiveKit delivery ACTIVE — /room/* and /livekit/webhook registered'
    : 'LiveKit delivery inactive — LIVEKIT_URL/API_KEY/API_SECRET not configured, HostedSessionProvider only',
);

// Q6 (#336): same boot-log convention — one Cloud Logging read answers
// "which dispatch transport and bot mode is THIS deploy running?".
app.log.info(
  meetBotImmediateDispatch
    ? 'MeetBot immediate dispatch ACTIVE (#336) — generate-now fire-and-forgets /internal/dispatch-meetbot; bots dispatch in voice-agent (Stage page) mode'
    : 'MeetBot immediate dispatch inactive — MEETBOT_IMMEDIATE_DISPATCH not set; dispatch uses the Cloud Tasks path when configured (websocket mode)',
);

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`Wellspring API listening on http://${host}:${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

/**
 * Graceful shutdown (docs/14_IMPROVEMENT_REVIEW.md §2.6 / issue #73):
 * Cloud Run sends SIGTERM before killing the container on scale-down/
 * redeploy. Without this handler, in-flight requests are dropped and pool
 * connections leak (the process just dies). `app.close()` stops accepting
 * new connections and waits for in-flight ones to finish; only THEN do we
 * end the pool, so no in-flight request loses its DB connection mid-query.
 * A hard 10s cap ensures a stuck close() can't hang the container forever
 * past Cloud Run's own termination grace period.
 */
let shuttingDown = false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info('SIGTERM received — starting graceful shutdown');

  const shutdown = (async () => {
    await app.close();
    await closePool();
  })();

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      app.log.error(`Graceful shutdown exceeded ${SHUTDOWN_CAP_MS}ms cap — forcing exit`);
      resolve();
    }, SHUTDOWN_CAP_MS).unref();
  });

  Promise.race([shutdown, timeout])
    .then(() => process.exit(0))
    .catch((err) => {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    });
});

/**
 * docs/14 §3.7: log, don't silently drop, unhandled promise rejections —
 * without this Node just prints a deprecation-style warning (or, on newer
 * Node defaults, crashes) with no structured context tying it back to the
 * app's own logger.
 */
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection');
});
