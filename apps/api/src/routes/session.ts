/**
 * GET /session/:token and POST /session/:token/complete — the public
 * join-link surface (EPIC D, issues #31/#33). Both routes are public: no
 * auth (Foundation §10: "API endpoints require auth ... except /status
 * and the session-join page") — the UUIDv4 token itself is the
 * credential (Foundation §10, docs/04 §5.1).
 *
 * Enumeration safety (docs/04 §5.4): unknown and expired-and-purged
 * tokens return the IDENTICAL HTTP 404 response body (same gentle HTML
 * page, no header or content difference that would let a caller
 * distinguish "never existed" from "existed once, now gone"). Docs/14
 * §2.9 / issue #72 extends this to a THIRD case that must be identical
 * too: a token that isn't even UUID-shaped (`GET /session/abc`). Before
 * this fix, a non-UUID token reached `sessionsRepository.findByToken`'s
 * `WHERE token = $1` against a `uuid` column, Postgres threw a cast error
 * (`22P02`), and — with no global error handler — Fastify's default
 * serialized that raw pg message into a 500, which is BOTH a Postgres
 * internals leak (§2.9's other half, fixed by app.ts's setErrorHandler as
 * defense-in-depth) AND an enumeration-safety break (a 500 is trivially
 * distinguishable from this route's normal 404). Validating the shape
 * here and routing it through the exact same `renderGoneOrUnknownPage()`
 * call as a well-formed-but-unknown token closes both holes at once.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SessionFeedbackBodySchema, UuidParamSchema } from '@kairos/shared-contracts';
import type { SessionService } from '../services/session/sessionService.js';
import {
  renderGoneOrUnknownPage,
  renderSessionCompletePage,
  renderSessionPage,
} from '../services/session/renderSessionPage.js';

export interface SessionRoutesDeps {
  sessionService: SessionService;
}

/** Length cap for the one-line prayer-intention field (docs/14 §5.5, issue #93) — generous enough for "one line" while keeping the field from becoming a free-form essay. */
const PRAYER_INTENTION_MAX_LENGTH = 500;

/**
 * `durationListenedSec` (issue #86, docs/03 §7): optional because the
 * currently-shipped session page is zero-JS by deliberate CSP policy
 * (docs/04 §5.3) and its plain HTML form has no field to send one — this
 * only has a value when/if a future client can measure playback time.
 *
 * `prayerIntention` (docs/14 §5.5, issue #93): the optional one-line
 * "anything you're carrying?" response, now backed by a real form field
 * (renderSessionPage.ts) and a form-urlencoded content-type parser
 * (app.ts's sessionScope) so a genuine HTML form POST actually delivers it.
 */
const SessionCompleteBodySchema = z
  .object({
    durationListenedSec: z.number().int().nonnegative(),
    prayerIntention: z.string().trim().min(1).max(PRAYER_INTENTION_MAX_LENGTH),
  })
  .partial();

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRoutesDeps): void {
  const { sessionService } = deps;

  app.get<{ Params: { token: string } }>('/session/:token', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }
    const result = await sessionService.getSessionView(token);

    if (result.kind === 'not_found') {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }

    return reply.status(200).type('text/html; charset=utf-8').send(renderSessionPage(result.page));
  });

  app.post<{ Params: { token: string } }>('/session/:token/complete', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }
    const parsedBody = SessionCompleteBodySchema.safeParse(request.body ?? {});
    const durationListenedSec = parsedBody.success
      ? (parsedBody.data.durationListenedSec ?? null)
      : null;
    const prayerIntention = parsedBody.success ? (parsedBody.data.prayerIntention ?? null) : null;
    const result = await sessionService.completeSession(token, { durationListenedSec, prayerIntention });

    if (result.kind === 'not_found') {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }

    // #297: the "Amen — mark complete" form is a zero-JS full-page POST, so a
    // browser submission used to land on this handler's raw JSON. When the
    // request is a browser navigation (a real HTML form POST — it accepts
    // text/html and/or arrives as form-urlencoded), 303-redirect to a calm
    // server-rendered confirmation instead. Genuine programmatic/JSON callers
    // (e.g. a future fetch-based client sending durationListenedSec as JSON)
    // still get the machine-readable `{ ok, completedAt }` body unchanged.
    if (wantsHtml(request.headers)) {
      return reply.redirect(`/session/${encodeURIComponent(token)}/complete`, 303);
    }

    return reply.status(200).send({ ok: true, completedAt: result.completedAt.toISOString() });
  });

  // #297: the friendly landing page a completed browser submission is
  // redirected to — and, since #321, the host of the post-Amen feedback
  // form (or its thanked state, once feedback exists). Enumeration-safe
  // like the other session routes — an unknown/expired token returns the
  // identical 404 "gone" page, never a confirmation that would leak
  // whether the token exists.
  app.get<{ Params: { token: string } }>('/session/:token/complete', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }
    const result = await sessionService.getCompletionView(token);
    if (result.kind === 'not_found') {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }
    return reply
      .status(200)
      .type('text/html; charset=utf-8')
      .send(
        renderSessionCompletePage({
          token: result.token,
          feedbackSubmitted: result.feedbackSubmitted,
          youVersionHighlightSaved: result.youVersionHighlightSaved,
        }),
      );
  });

  /**
   * P1 (#320): the end-of-session feedback channel. Public and
   * token-scoped like its siblings; accepts BOTH the zero-JS form's
   * urlencoded body (booleans arrive as the strings "true"/"false",
   * untouched radios/note simply absent or empty) and a JSON body —
   * `normalizeFeedbackBody` folds the former into the latter before the
   * one shared contract (`SessionFeedbackBodySchema`) validates.
   *
   * Status choices, documented per #320's acceptance criteria:
   *  - unknown/expired/non-UUID token → the identical 404 "gone" page
   *    (enumeration safety, docs/04 §5.4);
   *  - never-joined session → 409. This does confirm the token exists,
   *    but only to a caller who already HOLDS the token — the token is
   *    itself the credential (Foundation §10), so there is no third party
   *    to leak to; enumeration safety is about unknown-vs-expired, which
   *    stays airtight above. A browser can't normally reach this state
   *    (the form only renders after a GET that sets joined_at), so the
   *    409 carries the standard JSON error envelope rather than a page;
   *  - invalid body (unknown fields, bad enum value, >500-char note) →
   *    400 envelope. The form's maxlength/fixed radios make this
   *    unreachable without tampering, so no gentle-HTML variant either.
   */
  app.post<{ Params: { token: string } }>('/session/:token/feedback', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }

    const parsedBody = SessionFeedbackBodySchema.safeParse(normalizeFeedbackBody(request.body));
    if (!parsedBody.success) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: 'INVALID_FEEDBACK',
          message: 'The feedback could not be read. Nothing was recorded.',
          retryable: false,
        },
      });
    }

    const result = await sessionService.recordFeedback(token, parsedBody.data);

    if (result.kind === 'not_found') {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }
    if (result.kind === 'not_joined') {
      return reply.status(409).send({
        ok: false,
        error: {
          code: 'SESSION_NOT_JOINED',
          message: 'This session has not been opened yet.',
          retryable: true,
        },
      });
    }

    // Same fork as POST /complete (#297): a real zero-JS form submission
    // 303s back to the completion page — which now finds the feedback row
    // and renders the thanked state — while JSON callers get an envelope.
    if (wantsHtml(request.headers)) {
      return reply.redirect(`/session/${encodeURIComponent(token)}/complete`, 303);
    }

    return reply.status(200).send({ ok: true });
  });
}

/**
 * Folds the zero-JS form's urlencoded shape into the canonical JSON shape
 * before `SessionFeedbackBodySchema` validates (the "normalize before
 * parsing" pattern #320 mandates, mirroring SessionCompleteBodySchema's
 * handling above):
 *  - `"true"`/`"false"` strings (radio values — urlencoded has no
 *    booleans) become real booleans;
 *  - empty strings (an untouched note field posts `note=`) are dropped
 *    entirely — "unanswered", never a stored empty answer;
 *  - everything else passes through untouched, so a JSON caller's
 *    genuine type errors still reach the strict schema and fail loudly
 *    rather than being laundered here.
 *
 * Only the five contract keys are ever written to the normalized object
 * (never a request-controlled name — a `__proto__`/`constructor` key in
 * the body must not become a property write, the classic remote-property-
 * injection sink). A body carrying ANY unknown key skips normalization
 * entirely and goes to the schema as-is, so `.strict()` still rejects it
 * with a 400 instead of this function silently swallowing the field.
 */
const FEEDBACK_BODY_KEYS = ['contentHelpful', 'topicMore', 'lengthFeel', 'timeFeel', 'note'] as const;

function normalizeFeedbackBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body ?? {};
  }
  const source = body as Record<string, unknown>;
  const knownKeys: readonly string[] = FEEDBACK_BODY_KEYS;
  if (Object.keys(source).some((key) => !knownKeys.includes(key))) {
    return body;
  }
  const normalized: Record<string, unknown> = {};
  for (const key of FEEDBACK_BODY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const value = source[key];
    if (value === '') {
      continue;
    }
    if ((key === 'contentHelpful' || key === 'topicMore') && (value === 'true' || value === 'false')) {
      normalized[key] = value === 'true';
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * True when the request should be answered with an HTML page rather than JSON:
 * a real browser form POST both accepts `text/html` and (for this zero-JS
 * form) arrives as `application/x-www-form-urlencoded`. Either signal is
 * enough; a JSON API client (`content-type: application/json`, `accept:
 * application/json`) matches neither and keeps the JSON response.
 */
function wantsHtml(headers: Record<string, string | string[] | undefined>): boolean {
  const accept = String(headers['accept'] ?? '').toLowerCase();
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  return accept.includes('text/html') || contentType.includes('application/x-www-form-urlencoded');
}
