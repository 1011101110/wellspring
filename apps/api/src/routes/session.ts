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
import { UuidParamSchema } from '@kairos/shared-contracts';
import type { SessionService } from '../services/session/sessionService.js';
import {
  renderGoneOrUnknownPage,
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

    return reply.status(200).send({ ok: true, completedAt: result.completedAt.toISOString() });
  });
}
