/**
 * Regression: the internal cron triggers must not 415 on a bodyless
 * `application/octet-stream` POST — the shape Cloud Scheduler sends when a
 * job is created without an explicit `Content-Type: application/json`.
 *
 * ## Why this test exists
 *
 * `kairos-daily-devotionals` shipped to staging with
 * `Content-Type: application/octet-stream`, and Fastify — which has no
 * parser for that media type — rejected every request with **415 before
 * the handler ran**. The daily devotional generation loop was dead in
 * production for days and nothing surfaced it: a Cloud Scheduler job's
 * non-2xx response is invisible unless you go read the job's status. A
 * user found it the honest way — the dashboard said "your next devotional
 * is Monday" and Monday's calendar was empty, because nothing was ever
 * being generated.
 *
 * The unit tests in `internal.test.ts` could not catch this: they build a
 * bare Fastify instance and call `registerInternalRoutes` directly, so
 * they never exercise the content-type handling that lives in `buildApp`.
 * This one goes through the real `buildApp`, which is where the parser
 * (and therefore the bug) actually is.
 *
 * The assertion is deliberately "not 415", reached via the auth check:
 * content-type parsing happens at the framework level BEFORE the handler,
 * so a request that 415s never reaches the token check. An octet-stream
 * POST that instead returns 401 (missing token) has, by definition, been
 * parsed and handed to the handler — which is the whole fix.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { GenerateNowOrchestrator } from '../../src/services/orchestrator/generateNowOrchestrator.js';

/** The orchestrator is never reached in these tests (auth rejects first); a bare stub satisfies the type. */
const stubOrchestrator = {} as GenerateNowOrchestrator;

async function octetStreamPost(url: string, headers: Record<string, string> = {}) {
  const app = buildApp({
    internalRoutes: { generateNowOrchestrator: stubOrchestrator, internalApiToken: 'secret' },
  });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url,
    // Exactly what the misconfigured Cloud Scheduler job sent: this media
    // type, and a zero-byte body.
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: '',
  });
  await app.close();
  return res;
}

describe('internal triggers accept a bodyless octet-stream POST (daily-run 415 regression)', () => {
  it('does NOT 415 a Cloud-Scheduler-shaped POST to /internal/trigger-daily-run', async () => {
    const res = await octetStreamPost('/internal/trigger-daily-run');
    // The bug was 415 (parse-layer rejection). The fix routes the request
    // to the handler, where the missing token is a 401 — proof the body
    // was accepted and parsed.
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).toBe(401);
  });

  it('accepts it when the token is present, reaching the handler', async () => {
    // With the token, the request must get past both the parser AND auth.
    // `users` is unwired, so the handler answers 501 — but crucially not
    // 415 and not 401. Any of those non-415/401 codes proves the octet-
    // stream body reached the handler.
    const res = await octetStreamPost('/internal/trigger-daily-run', {
      'x-internal-token': 'secret',
    });
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(501);
  });

  it('also protects the other cron triggers (purge)', async () => {
    // Same fix, same scope — every internal trigger is covered, so the
    // next job created with the wrong content-type cannot silently die.
    const res = await octetStreamPost('/internal/purge');
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).toBe(401);
  });
});
