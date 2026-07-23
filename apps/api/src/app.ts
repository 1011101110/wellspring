import querystring from 'node:querystring';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { ErrorEnvelopeSchema, GENERIC_INTERNAL_ERROR_MESSAGE } from '@kairos/shared-contracts';
import { registerAudioRoutes } from './routes/audio.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerUserScopedRoutes } from './routes/userScoped.js';
import { registerDevotionalAudioRoutes } from './routes/devotionalAudio.js';
import { registerDevotionalSearchRoutes } from './routes/devotionalSearch.js';
import { registerInternalRoutes, type InternalRoutesDeps } from './routes/internal.js';
import { registerSlotsRoutes } from './routes/slots.js';
import { registerConnectRoutes, type ConnectRoutesDeps } from './routes/connect.js';
import {
  registerCalendarFreeBusyRoutes,
  type CalendarFreeBusyRoutesDeps,
} from './routes/calendarFreeBusy.js';
import { registerRoomRoutes, type RoomRoutesDeps } from './routes/room.js';
import { registerStageRoutes, type StageRoutesDeps } from './routes/stage.js';
import { registerLiveKitWebhookRoutes, type LiveKitWebhookRoutesDeps } from './routes/livekitWebhook.js';
import { registerMeetBotAudioRoutes, type MeetBotAudioRoutesDeps } from './routes/meetBotAudio.js';
import { registerInboundInviteRoutes, type InboundInviteRoutesDeps } from './routes/inboundInvite.js';
import fastifyWebsocket from '@fastify/websocket';
import { registerAuth } from './auth/middleware.js';
import { auditV1RoutesRequireAuth } from './auth/routeAudit.js';
import type { TokenVerifier } from './auth/tokenVerifier.js';
import { FirebaseTokenVerifier } from './auth/firebaseTokenVerifier.js';
import type { SessionService } from './services/session/sessionService.js';
import type { Repositories } from './db/repositories/index.js';
import type { AudioStorage } from './services/audio/audioStorage.js';

export interface BuildAppOptions {
  /**
   * Injected so tests (and local dev without a live Firebase project)
   * can pass a `FakeTokenVerifier` instead of the real Firebase-backed
   * one. Defaults to `FirebaseTokenVerifier`, which is wired but not
   * live-tested — see src/auth/firebaseTokenVerifier.ts.
   */
  tokenVerifier?: TokenVerifier;
  /**
   * Injected so tests can wire a `SessionService` backed by a real (test)
   * Postgres pool + `AudioStorage`. When omitted, `/session/:token`
   * routes are not registered — most unit-style tests of other routes
   * don't need a database at all, so this is opt-in rather than
   * defaulting to a live pool connection at buildApp() time.
   */
  sessionService?: SessionService;
  /**
   * Injected so tests can wire the minimal authenticated user-scoped API
   * surface (issue #42's authz-probe target routes: /v1/preferences,
   * /v1/bands, /v1/devotionals, /v1/sessions, /v1/calendar-events,
   * /v1/account). Omitted by default for the same reason as
   * `sessionService` — most tests don't need a database.
   */
  repositories?: Repositories;
  /**
   * AudioStorage for (a) the user-scoped routes' `DELETE /v1/account`
   * (needs to remove the user's audio files, not just DB rows — issue
   * #44), required together with `repositories` for user-scoped routes
   * to register; and (b) `GET /audio/:token` in the session scope (issue
   * #68, docs/14 §1.2), registered whenever `sessionService` is also
   * provided (the same condition that registers `/session/:token`,
   * since both serve the same public join-link surface). Harmless to
   * omit when both `repositories` and `sessionService` are also omitted.
   */
  audioStorage?: AudioStorage;
  /**
   * Session-route rate limit overrides — tests need a low `max` to
   * exercise 429 without hammering hundreds of requests. Defaults to
   * production-sane values (docs/04_DATA_PRIVACY_SECURITY.md §5.4:
   * "rate limiting on public endpoints ... keyed by token+IP").
   */
  sessionRateLimit?: { max: number; timeWindowMs: number };
  /**
   * Rate limit override for the authenticated `/v1/*` + `/status` surface
   * (docs/14_IMPROVEMENT_REVIEW.md §2.8 / issue #87 — this surface had no
   * rate limiting at all, only the public session-join routes did). Same
   * override rationale as `sessionRateLimit`: tests need a low `max` to
   * exercise 429 without hundreds of requests.
   */
  apiRateLimit?: { max: number; timeWindowMs: number };
  /**
   * Wires `POST /internal/generate-now` (issue #74, docs/14 §4.1) — see
   * routes/internal.ts. Omitted by default so tests that don't need the
   * orchestrator (most of them) don't have to construct one; when omitted,
   * the internal routes are simply not registered.
   */
  internalRoutes?: InternalRoutesDeps;
  /**
   * Wires `POST /v1/devotional/generate-now` (distress check-in front
   * door, issue #77, docs/14 §5.8) — see routes/userScoped.ts. Reuses the
   * same orchestrator instance as `internalRoutes.generateNowOrchestrator`
   * when both are present. Omitted by default; the route then returns 501
   * rather than skipping registration of every other user-scoped route.
   */
  generateNowOrchestrator?: InternalRoutesDeps['generateNowOrchestrator'];
  /**
   * `INVITE_EMAIL_DOMAIN` — surfaces the user's invite routing address on
   * `GET /v1/preferences` (L3, issue #239). Omitted, the field is simply
   * absent from that payload and the clients hide the invite card; see
   * `UserScopedRoutesDeps.inviteEmailDomain` for why absence (rather than
   * an empty or half-built address) is the contract.
   */
  inviteEmailDomain?: string;
  /**
   * Per-user rate limit override for `POST /v1/devotional/generate-now`
   * (L2, issue #238) — same test-override rationale as `apiRateLimit`
   * above. See `UserScopedRoutesDeps.generateNowRateLimit`.
   */
  generateNowRateLimit?: { max: number; timeWindowMs: number };
  /**
   * Wires `POST /v1/slots` (issue #74, docs/14 §4.1 step 3) — see
   * routes/slots.ts. Registered whenever `repositories` is present (the
   * route only needs `repositories.candidateSlots`, same convention as the
   * other user-scoped routes above).
   */
  /**
   * Wires Google Calendar OAuth routes: GET /v1/connect/google,
   * GET /v1/connect/google/callback, DELETE /v1/connect/google,
   * GET /v1/connections (issue #22, docs/03 §8.1).
   * When omitted, these routes are simply not registered — tests that don't
   * need OAuth don't have to supply connectRoutes.
   */
  connectRoutes?: ConnectRoutesDeps;
  /**
   * Wires GET /v1/calendar/freebusy (M1, #255) — the dashboard calendar
   * view's live free/busy proxy. Optional on the same terms as
   * `connectRoutes`: it needs a configured `GoogleCalendarClient` and KMS
   * to mean anything, so a deploy without Calendar integration simply
   * does not register it.
   *
   * Deliberately NOT folded into the `repositories && audioStorage` block
   * with the other user-scoped routes — those need only our own database,
   * whereas this route cannot answer at all without live Google access.
   */
  calendarFreeBusyRoutes?: CalendarFreeBusyRoutesDeps;
  /**
   * Wires GET /room/:token, GET /room/:token/token, and GET
   * /room/assets/join.js (D4/#32, docs/22 §2.1/§4) — the LiveKit room-join
   * surface. Omitted by default; when omitted these routes are not
   * registered, matching every other optional-integration convention in
   * this file (connectRoutes, internalRoutes, etc.) — a deploy with no
   * LiveKit account configured yet boots and serves normally.
   */
  roomRoutes?: RoomRoutesDeps;
  /**
   * Wires GET /stage/:token + GET /stage/assets/stage.js (Q2 #332 / Q3
   * #333, epic #330) — the Stage page Attendee's browser-voice-agent
   * loads into a Google Meet, and the standalone demo floor. Gets its OWN
   * encapsulated child scope with a JS-enabled CSP (`script-src 'self'`,
   * modeled on the room scope) — the session scope's zero-JS CSP is
   * untouched. Uses the READ-ONLY `getStageView` (never marks
   * `joined_at`). Optional on the same terms as `roomRoutes`.
   */
  stageRoutes?: StageRoutesDeps;
  /**
   * Wires POST /livekit/webhook (D4/#32) — LiveKit Cloud calls this on
   * `room_started` so the backend can join as a bot and publish the
   * devotional's TTS audio (routes/livekitWebhook.ts). Auth is LiveKit's
   * own webhook signature (WebhookReceiver), not our INTERNAL_API_TOKEN
   * scheme — this is a third-party-signed callback, not a server-to-
   * server trigger we control. Omitted by default alongside roomRoutes.
   */
  liveKitWebhookRoutes?: LiveKitWebhookRoutesDeps;
  /**
   * H1a (#129) live spike only — the real websocket audio server Attendee
   * connects out to. Not the permanent H1c wiring (routes/meetBotAudio.ts
   * file header). Auth is a per-devotional capability token in the URL
   * path, derived from a dedicated MEETBOT_AUDIO_TOKEN root secret (#221)
   * — deliberately NOT INTERNAL_API_TOKEN, since this URL is sent to a
   * third party (Attendee). Gated on live consent at connect time and on
   * a durable play-once ledger (#221). Omitted by default.
   */
  meetBotAudioRoutes?: MeetBotAudioRoutesDeps;
  /**
   * Epic I (#60), issue #61 — the inbound invite-ingestion webhook
   * (routes/inboundInvite.ts). Omitted by default; no Resend account or
   * receiving domain exists yet (see docs/12 §1.4, docs/00_FOUNDATION.md
   * §11's Must-confirm convention).
   */
  inboundInviteRoutes?: InboundInviteRoutesDeps;
}

const DEFAULT_SESSION_RATE_LIMIT = { max: 30, timeWindowMs: 60_000 };

// docs/14_IMPROVEMENT_REVIEW.md §2.8 / issue #87: 120/min/IP is generous
// enough for a real client's normal polling/refresh behavior (nothing in
// the app polls faster than once per few seconds) while still bounding a
// single abusive or malfunctioning client.
const DEFAULT_API_RATE_LIMIT = { max: 120, timeWindowMs: 60_000 };

/**
 * Builds (but does not start) the Fastify app. Kept separate from the
 * process entrypoint (src/index.ts) so tests can exercise routes with
 * `app.inject()` without binding a port.
 */
/**
 * `/session/:token` and `/audio/:token` carry a bearer-style capability
 * credential IN THE PATH (docs/14 §2.1 / issue #79) — Fastify's default
 * request logging (and Cloud Run's own platform request logs, which we
 * cannot touch) would otherwise write every live token to Cloud Logging,
 * readable by anyone with project log-read access. Redacting only the
 * segment after the known-safe route prefix keeps the log line useful
 * for debugging (method, route shape, timing) without the credential
 * itself. Residual risk (Cloud Run's own access logs) is accepted and
 * documented in docs/04 §6 — tokens are single-devotional-scoped and
 * expire in 48h, bounding the damage.
 */
export function redactCapabilityToken(url: string): string {
  // `stage` (Q2 #332) carries the same session capability token as
  // /session — same redaction. `/stage/assets/*` never matches: `assets`
  // would be swallowed as the "token" segment, but that path carries no
  // credential, and a redacted static-asset log line is harmless anyway.
  return url.replace(/^(\/(?:session|audio|room|stage)\/)[^/?]+/, '$1<redacted>');
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      serializers: {
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: redactCapabilityToken(request.url),
            version: request.headers['accept-version'] as string | undefined,
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket ? request.socket.remotePort : undefined,
          };
        },
      },
    },
    // docs/14_IMPROVEMENT_REVIEW.md §2.12 / issue #73: Cloud Run terminates
    // TLS and proxies every request through its own front end, so without
    // this the rate limiter's `request.ip` (used to key the session-scope
    // limiter, app.ts below) sees Cloud Run's hop IP for every client —
    // collapsing the whole limiter onto one shared bucket instead of one
    // per real client. `trustProxy: true` makes Fastify honor
    // X-Forwarded-For from the (trusted, since Cloud Run itself is the only
    // thing that can reach this container) upstream hop.
    trustProxy: true,
    routerOptions: {
      // find-my-way (Fastify's router) defaults maxParamLength to 100 —
      // too short for our signed-URL-style tokens (:token on
      // /session/:token and /audio/:token): a base64url HMAC-signed
      // payload ({objectKey, exp, nonce} JSON + a SHA-256 signature, "."
      // joined) routinely exceeds 100 chars, which without this override
      // causes find-my-way to reject the request with 414 BEFORE any
      // route handler (including the enumeration-safe 404 logic) ever
      // runs — silently breaking every real /audio/:token and
      // long-token /session/:token request (issue #68, docs/14 §1.2).
      maxParamLength: 512,
    },
  });

  // Global error handler (docs/14 §2.9 / issue #72): Fastify 5's DEFAULT
  // handler serializes `error.message` straight into the response body,
  // which for an uncaught pg error (a cast failure, a constraint
  // violation, anything not explicitly handled by a route) echoes raw
  // Postgres internals to the client — including, in the worst case,
  // fragments of the query or the offending input value. This handler
  // replaces that default for EVERY route (there is no scope/prefix
  // limiting it) for any error that ISN'T already one of our own
  // well-formed envelopes: log the real error server-side (via
  // `request.log`, so it lands in the same structured log stream as
  // everything else and is still fully debuggable operationally), then
  // always emit the SAME generic envelope + message to the client — never
  // `error.message`, never a stack trace, never a Zod/pg-specific field
  // name.
  //
  // `@fastify/rate-limit`'s `errorResponseBuilder` (below) constructs and
  // `throw`s its OWN already-safe `{ ok, error: { code, message,
  // retryable } }` object (see that plugin's own defaultErrorResponse
  // pattern) with a `statusCode` attached — Fastify routes that throw
  // through this SAME setErrorHandler (there is no way to opt a specific
  // plugin's throws out of it), so without this passthrough check the
  // rate-limiter's carefully-built `RATE_LIMITED` envelope would be
  // silently overwritten by the generic one below, changing its `code`/
  // `message` on every 429. Detecting "does this already look like one of
  // our envelopes" via `ErrorEnvelopeSchema` and returning it unchanged
  // when it does keeps that plugin's specific, useful error surfaced
  // while still catching everything genuinely unexpected (pg errors,
  // arbitrary thrown Errors, etc.) with the generic message.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;

    const alreadyEnvelope = ErrorEnvelopeSchema.safeParse(error);
    if (alreadyEnvelope.success) {
      // A deliberately-constructed, already-safe envelope (e.g. the rate
      // limiter's) — nothing to redact, log at a lower severity than a
      // genuinely unexpected error, and pass it through unchanged.
      request.log.warn({ err: error }, 'request rejected with a pre-built error envelope');
      return reply.status(statusCode).send(alreadyEnvelope.data);
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply.status(statusCode).send({
      ok: false,
      error: {
        code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: GENERIC_INTERNAL_ERROR_MESSAGE,
        retryable: statusCode >= 500,
      },
    });
  });

  /**
   * CORS for the web client (#195).
   *
   * The API had NO CORS configuration at all — found by loading the deployed
   * web app in a browser and watching every `/v1` call die on `Failed to
   * fetch`. Nothing caught it earlier because nothing needed it: iOS is a
   * native client and same-origin server-rendered pages don't trigger a
   * preflight. The build, the tests, the deploy and the SHA check were all
   * green against an API the browser could not talk to.
   *
   * Strict origin ALLOWLIST, never `origin: true`. Reflecting an arbitrary
   * Origin would let any site a signed-in user visits issue credentialed
   * requests against this API with their bearer token.
   *
   * The allowed web origin(s) come entirely from `WEB_APP_BASE_URL` — a
   * comma-separated list, so a project served on both `.web.app` and
   * `.firebaseapp.com` sets both — plus localhost in non-production. No
   * origin is hardcoded here: this is an open-source repo, and the deploy
   * supplies the real origins from a GitHub Actions variable. An empty
   * `WEB_APP_BASE_URL` in production means no browser origin is allowed,
   * which fails safe (closed), not open.
   *
   * `credentials` stays false: auth here is an `Authorization: Bearer`
   * header, not a cookie, so the browser needs no credentialed-request mode
   * and enabling it would only widen what a misconfigured origin could do.
   */
  const corsOrigins = [
    ...(process.env.WEB_APP_BASE_URL ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o.length > 0),
    ...(process.env.NODE_ENV !== 'production'
      ? ['http://localhost:5173', 'http://127.0.0.1:5173']
      : []),
  ];
  app.register(fastifyCors, {
    origin: [...new Set(corsOrigins)],
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 600,
  });

  const tokenVerifier = options.tokenVerifier ?? new FirebaseTokenVerifier();
  registerAuth(app, tokenVerifier, options.repositories?.users);

  // Default-deny invariant (issue #80, docs/14 §2.3): must be registered
  // before any route below so its `onRoute` hook observes all of them.
  // Crashes app startup (onReady) if any /v1/* route is missing
  // `requireAuth` and isn't in this allowlist — see routeAudit.ts.
  auditV1RoutesRequireAuth(app, {
    allowedPublicV1Routes: [
      // Google's OAuth redirect — no Authorization header is possible here.
      '/v1/connect/google/callback',
    ],
  });

  // Encapsulated child scope (Fastify plugin boundary) for the whole
  // authenticated `/v1/*` + `/status` surface (docs/14_IMPROVEMENT_REVIEW.md
  // §2.8/§2.12 / issue #87) — until now this surface had NEITHER rate
  // limiting NOR baseline security headers at all, unlike the public
  // session-join scope below which has had both since issue #73/#79. Kept
  // as its own scope (rather than applied to the top-level `app`) so
  // `/internal/generate-now` (shared-secret auth, not a public/client-
  // facing surface) and the session-join routes (already covered by their
  // own tuned token+IP limiter) aren't double-limited.
  app.register(async (apiScope) => {
    await apiScope.register(fastifyHelmet, {
      // JSON API responses, not HTML — no CSP needed (that's the session
      // page's job, above); baseline headers only (X-Content-Type-Options,
      // X-Frame-Options, etc. — helmet's defaults).
      contentSecurityPolicy: false,
      hsts: { maxAge: 15552000, includeSubDomains: true },
    });

    const apiRateLimit = options.apiRateLimit ?? DEFAULT_API_RATE_LIMIT;
    await apiScope.register(fastifyRateLimit, {
      max: apiRateLimit.max,
      timeWindow: apiRateLimit.timeWindowMs,
      // IP-keyed, not token+IP like the session scope below — every route
      // here is Firebase-auth-gated (docs/14 §2.3 / issue #80), not
      // capability-token-gated, so there is no per-resource token to key
      // on the way the session scope does.
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: (_request, context) => ({
        statusCode: context.statusCode,
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
      }),
    });

    registerHealthRoutes(apiScope);

    if (options.repositories && options.audioStorage) {
      registerUserScopedRoutes(apiScope, {
        repositories: options.repositories,
        audioStorage: options.audioStorage,
        // DELETE /v1/account revokes the Google token before deleting rows
        // (issue #81) — reuses the same oauthService/kmsService instances as
        // connectRoutes below, when Calendar integration is configured.
        oauth: options.connectRoutes
          ? {
              connections: options.repositories.connections,
              kmsService: options.connectRoutes.kmsService,
              oauthService: options.connectRoutes.oauthService,
            }
          : undefined,
        generateNowOrchestrator: options.generateNowOrchestrator,
        // L3 (#239) — the domain half of `u_<userId>@<domain>`.
        inviteEmailDomain: options.inviteEmailDomain,
        // L2 (#238) — per-user limit on the one route that spends money.
        generateNowRateLimit: options.generateNowRateLimit,
      });

      // GET /v1/devotionals/:id/audio (EPIC L, issues #236/#241) — the
      // authenticated replay path for the dashboard's devotional history.
      // Registered in this scope (not the session scope) precisely because
      // it is Firebase-auth-gated rather than capability-token-gated: the
      // whole point is that replay does NOT depend on a session token,
      // which expires at event-end + 48h. See routes/devotionalAudio.ts.
      registerDevotionalAudioRoutes(apiScope, {
        repositories: options.repositories,
        audioStorage: options.audioStorage,
      });
    }

    if (options.repositories) {
      // GET /v1/devotionals/search (issue #242) — its own module rather
      // than part of registerUserScopedRoutes above, but the same
      // authenticated scope, so it inherits this scope's helmet headers
      // and rate limit and is covered by the default-deny audit (#80).
      //
      // Registered independently of `audioStorage` (which the block above
      // requires and search has no use for) so a deployment without audio
      // configured still gets search.
      //
      // Route-shadowing note: this coexists with `/v1/devotionals/:id`
      // from userScoped.ts. Fastify's radix router always prefers a
      // static segment over a parametric one, so "search" is never
      // swallowed as an `:id` regardless of which module registers
      // first — asserted in tests/routes/devotionalSearch.test.ts rather
      // than left as an assumption about router internals.
      registerDevotionalSearchRoutes(apiScope, { repositories: options.repositories });

      // POST /v1/slots (issue #74, docs/14 §4.1 step 3) — only needs
      // repositories.candidateSlots; kept as its own additive condition
      // (rather than folded into the block above) so it doesn't newly
      // require audioStorage, which it has no use for.
      registerSlotsRoutes(apiScope, { candidateSlots: options.repositories.candidateSlots });
    }

    if (options.connectRoutes) {
      // OAuth2 connection routes: /v1/connect/google, /v1/connect/google/callback,
      // DELETE /v1/connect/google, GET /v1/connections (issue #22).
      // The callback route is intentionally NOT behind verifyFirebaseToken —
      // it is a Google redirect with no Authorization header.
      registerConnectRoutes(apiScope, options.connectRoutes);
    }

    if (options.calendarFreeBusyRoutes) {
      // GET /v1/calendar/freebusy (M1, #255). Registered inside the /v1
      // apiScope so it inherits helmet and the IP-keyed rate limiter along
      // with every other client-facing route — this one reads through to a
      // metered third-party API, so the shared limiter is doing real work
      // here rather than being a formality.
      registerCalendarFreeBusyRoutes(apiScope, options.calendarFreeBusyRoutes);
    }
  });

  if (options.internalRoutes) {
    // /internal/generate-now (issue #74, docs/14 §4.1) — placeholder
    // shared-secret auth (routes/internal.ts), not on the public /v1
    // surface and deliberately not inside the session scope's helmet/
    // rate-limit config (that scope is for the public join-link surface),
    // nor inside the /v1 apiScope above (that scope is for the public
    // client-facing surface — this is a server-to-server trigger).
    //
    // Scoped so the octet-stream parser below reaches ONLY these routes.
    app.register(async (internalScope) => {
      // Cloud Scheduler POSTs the cron triggers (`trigger-daily-run`,
      // `purge`, etc.) with a zero-byte body — but a job created with
      // `Content-Type: application/octet-stream` instead of
      // `application/json` sends a media type Fastify has no parser for,
      // and Fastify rejects it with 415 BEFORE the handler runs. That is
      // not hypothetical: `kairos-daily-devotionals` shipped with exactly
      // that header and every daily run 415'd silently for days — the core
      // generation loop was dead in production and nothing surfaced it,
      // because a scheduler job's non-2xx is invisible unless you go
      // looking. These triggers do not read their body at all, so the
      // server has no reason to be picky about how an empty one is
      // labelled. Accept octet-stream: empty -> `{}`, and anything present
      // -> JSON (so a Cloud Tasks per-user call that happens to use this
      // type still parses). This makes the trigger robust to the job's
      // content-type rather than dependent on it.
      internalScope.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'string' },
        (_request, body, done) => {
          const text = (body as string).trim();
          if (text.length === 0) return done(null, {});
          try {
            done(null, JSON.parse(text));
          } catch (err) {
            done(err as Error, undefined);
          }
        },
      );
      registerInternalRoutes(internalScope, options.internalRoutes!);
    });
  }

  if (options.sessionService) {
    const rateLimit = options.sessionRateLimit ?? DEFAULT_SESSION_RATE_LIMIT;
    // Encapsulated child scope (Fastify plugin boundary) so helmet/CSP and
    // rate-limiting apply ONLY to the public session-join surface, not the
    // whole app (docs/04 §5.3 "strict CSP ... on the session page"; §5.4
    // "rate limiting on public endpoints [session fetch, completion] keyed
    // by token+IP" — not every route needs either).
    app.register(async (sessionScope) => {
      await sessionScope.register(fastifyHelmet, {
        // No third-party script sources (docs/04 §5.3) — the session page
        // ships zero inline/external JS, so a maximally restrictive CSP
        // costs nothing. `unsafe-inline` on style is required for the
        // page's inline <style> block (renderSessionPage.ts pageShell).
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'none'"],
            scriptSrc: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'"],
            // 'self' covers this same-origin GET /audio/:token route
            // (local-file mode); storage.googleapis.com covers GCS-mode
            // V4 signed URLs, which are cross-origin from the browser's
            // perspective (docs/14 §2.10 — without this, GCS-mode audio
            // is blocked by our own CSP even though the backend wiring
            // is otherwise correct).
            mediaSrc: ["'self'", 'https://storage.googleapis.com'],
            formAction: ["'self'"],
            connectSrc: ["'self'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
          },
        },
        // HSTS on the session page (docs/04 §5.3). Cloud Run terminates
        // TLS in front of the app; the header itself is what matters here.
        hsts: { maxAge: 15552000, includeSubDomains: true },
        crossOriginEmbedderPolicy: false, // would block the <audio> element's cross-origin signed-URL source
      });

      await sessionScope.register(fastifyRateLimit, {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindowMs,
        // Token+IP keyed (docs/04 §5.4) — the token is the capability
        // credential, so limiting must key on it (not just IP, which would
        // let one abusive client hammer many different users' tokens
        // under the same budget) and on IP (so one leaked token can't be
        // hammered from many source IPs under a single shared budget).
        keyGenerator: (request) => {
          const token = (request.params as { token?: string } | undefined)?.token ?? 'no-token';
          return `${token}:${request.ip}`;
        },
        errorResponseBuilder: (_request, context) => ({
          // @fastify/rate-limit `throw`s this object and relies on
          // `statusCode` to drive the actual HTTP response code — without
          // it Fastify's default error handler treats the throw as an
          // unexpected 500. See node_modules/@fastify/rate-limit's
          // defaultErrorResponse for the same pattern.
          statusCode: context.statusCode,
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
        }),
      });

      // The session-completion page's `<form method="post">` submits as
      // `application/x-www-form-urlencoded` (docs/14 §5.5, issue #93) —
      // without a parser for it, Fastify leaves `request.body` empty for a
      // real browser submit and only a JSON POST could ever populate it
      // (see session.ts's SessionCompleteBodySchema comment). Scoped to
      // this plugin only, since it's the one route that receives real HTML
      // form submissions.
      sessionScope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_request, body, done) => {
          try {
            done(null, querystring.parse(body as string));
          } catch (err) {
            done(err as Error, undefined);
          }
        },
      );

      registerSessionRoutes(sessionScope, { sessionService: options.sessionService! });

      // GET /audio/:token (issue #68, docs/14 §1.2) needs the raw
      // AudioStorage instance (to verify the LocalFileAudioStorage token
      // and stream bytes), not the SessionService wrapper — only
      // register it when both are present, so a test that wires
      // sessionService without audioStorage (there shouldn't be one,
      // since SessionService itself requires audioStorage, but this
      // guard costs nothing) doesn't crash on a missing dependency.
      if (options.audioStorage) {
        registerAudioRoutes(sessionScope, { audioStorage: options.audioStorage });
      }
    });
  }

  if (options.roomRoutes) {
    const liveKitHost = options.roomRoutes.liveKitConfig.url.replace(/^wss?:\/\//, '');
    // Encapsulated child scope, own CSP — unlike the session scope above,
    // this page necessarily runs JavaScript (the LiveKit client SDK), so
    // it cannot reuse that scope's `scriptSrc: ["'none'"]`. Kept as its
    // own scope rather than loosening the session scope's CSP for
    // everyone (D4/#32, docs/22 §2.1/§4).
    app.register(async (roomScope) => {
      await roomScope.register(fastifyHelmet, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'none'"],
            // 'self' serves /room/assets/join.js; jsdelivr serves the
            // LiveKit client UMD bundle (renderRoomPage.ts).
            scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'"],
            // 'self' for the /room/:token/token fetch; wss://<livekit host>
            // for the actual room connection the LiveKit client SDK opens.
            connectSrc: ["'self'", `wss://${liveKitHost}`],
            formAction: ["'none'"],
            baseUri: ["'none'"],
            frameAncestors: ["'none'"],
          },
        },
        hsts: { maxAge: 15552000, includeSubDomains: true },
      });

      const rateLimit = options.sessionRateLimit ?? DEFAULT_SESSION_RATE_LIMIT;
      await roomScope.register(fastifyRateLimit, {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindowMs,
        // Same token+IP keying rationale as the session scope above — the
        // token is the capability credential here too.
        keyGenerator: (request) => {
          const token = (request.params as { token?: string } | undefined)?.token ?? 'no-token';
          return `${token}:${request.ip}`;
        },
        errorResponseBuilder: (_request, context) => ({
          statusCode: context.statusCode,
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
        }),
      });

      registerRoomRoutes(roomScope, options.roomRoutes!);
    });
  }

  if (options.stageRoutes) {
    // Encapsulated child scope, own JS-enabled CSP (Q2 #332) — the Stage
    // page necessarily runs JavaScript (caption sync off audio.currentTime),
    // so like the room scope above it cannot live under the session
    // scope's `scriptSrc: ["'none'"]`. Own scope rather than loosening the
    // session CSP for everyone; the session page's CSP tests still pin the
    // zero-JS policy there.
    app.register(async (stageScope) => {
      await stageScope.register(fastifyHelmet, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'none'"],
            // 'self' serves /stage/assets/stage.js — no CDN, no inline
            // (the timeline JSON rides in a non-executable
            // <script type="application/json"> block).
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'"],
            // Same signed-URL rationale as the session scope above:
            // 'self' covers local-file mode's /audio/:token, and
            // storage.googleapis.com covers GCS-mode V4 signed URLs
            // (docs/14 §2.10).
            mediaSrc: ["'self'", 'https://storage.googleapis.com'],
            connectSrc: ["'self'"],
            formAction: ["'none'"],
            baseUri: ["'none'"],
            // No embedding for now — Q8 (Meet Add-on iframe) would revisit.
            frameAncestors: ["'none'"],
          },
        },
        hsts: { maxAge: 15552000, includeSubDomains: true },
        crossOriginEmbedderPolicy: false, // would block the <audio> element's cross-origin signed-URL source
      });

      const rateLimit = options.sessionRateLimit ?? DEFAULT_SESSION_RATE_LIMIT;
      await stageScope.register(fastifyRateLimit, {
        max: rateLimit.max,
        timeWindow: rateLimit.timeWindowMs,
        // Same token+IP keying rationale as the session scope — the token
        // is the capability credential here too (docs/04 §5.4).
        keyGenerator: (request) => {
          const token = (request.params as { token?: string } | undefined)?.token ?? 'no-token';
          return `${token}:${request.ip}`;
        },
        errorResponseBuilder: (_request, context) => ({
          statusCode: context.statusCode,
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
        }),
      });

      registerStageRoutes(stageScope, options.stageRoutes!);
    });
  }

  if (options.liveKitWebhookRoutes) {
    // Not inside the room scope's CSP/rate-limit — this is a
    // server-to-server callback from LiveKit Cloud, authenticated by its
    // own webhook signature (routes/livekitWebhook.ts), not a browser page.
    registerLiveKitWebhookRoutes(app, options.liveKitWebhookRoutes);
  }

  if (options.meetBotAudioRoutes) {
    // H1a (#129) live spike only — see BuildAppOptions.meetBotAudioRoutes
    // and routes/meetBotAudio.ts. A websocket server-to-server callback
    // from Attendee, not a browser page — no CSP/rate-limit scope needed.
    app.register(fastifyWebsocket);
    app.register(async (meetBotScope) => {
      registerMeetBotAudioRoutes(meetBotScope, options.meetBotAudioRoutes!);
    });
  }

  if (options.inboundInviteRoutes) {
    // Epic I (#60), issue #61 — a server-to-server webhook from Resend,
    // authenticated by its own Svix signature, not a browser page — no
    // CSP/rate-limit scope needed, same reasoning as the webhooks above.
    registerInboundInviteRoutes(app, options.inboundInviteRoutes);
  }

  return app;
}
