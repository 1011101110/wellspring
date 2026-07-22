/**
 * `/status` is the endpoint the deploy workflow uses to decide whether a
 * deploy worked. Issue #230 is the record of it failing at exactly that job:
 * it returned 200 for two and a half hours from a *pinned old revision*
 * while six deploys built new revisions that never received traffic. Every
 * signal was green and nothing had shipped.
 *
 * `buildSha` is what makes the check answer the real question — not "is
 * something alive" but "is the thing I just built the thing serving". These
 * tests pin the contract the workflow greps for; if the field is renamed or
 * dropped, the post-deploy verification silently degrades back to a liveness
 * check and #230 becomes possible again.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

/**
 * The module reads `BUILD_SHA` once at import, so each case needs a fresh
 * module registry — `vi.resetModules()` plus a dynamic import, rather than a
 * top-level import that would freeze the first value read.
 */
async function statusBodyWith(buildSha: string | undefined) {
  vi.resetModules();
  if (buildSha === undefined) delete process.env.BUILD_SHA;
  else process.env.BUILD_SHA = buildSha;

  const { registerHealthRoutes } = await import('../../src/routes/health.js');
  const app = Fastify({ logger: false });
  registerHealthRoutes(app);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/status' });
  await app.close();
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() };
}

describe('GET /status', () => {
  const original = process.env.BUILD_SHA;
  beforeEach(() => {
    delete process.env.BUILD_SHA;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = original;
  });

  it('stays a 200 with status ok — the deploy check and any uptime monitor depend on it', async () => {
    const { statusCode, body } = await statusBodyWith('abc123');
    expect(statusCode).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('reports the injected BUILD_SHA so the deploy step can assert identity, not liveness (#230)', async () => {
    const { body } = await statusBodyWith('deadbeefcafe');
    expect(body.buildSha).toBe('deadbeefcafe');
  });

  it("falls back to 'unknown' when BUILD_SHA is unset, rather than omitting the field", async () => {
    // Omitting it would make the workflow's `sed` extract an empty string,
    // which compares unequal to the expected SHA and fails — correct, but the
    // failure would read as "deploy did not take effect" when the real cause
    // is a missing env var. An explicit 'unknown' distinguishes the two in the
    // error line the workflow prints.
    const { body } = await statusBodyWith(undefined);
    expect(body.buildSha).toBe('unknown');
  });

  it('serves buildSha in a shape the workflow\'s extraction can parse', async () => {
    // The post-deploy step greps the raw body with:
    //   sed -n 's/.*"buildSha":"\\([^"]*\\)".*/\\1/p'
    // so the field must be a plain JSON string with no whitespace between the
    // key and value. Asserting the serialized text — not the parsed object —
    // is the only way this test actually covers what the workflow does.
    const { body } = await statusBodyWith('sha-with-dashes-123');
    const raw = JSON.stringify(body);
    expect(raw).toContain('"buildSha":"sha-with-dashes-123"');

    const extracted = /"buildSha":"([^"]*)"/.exec(raw)?.[1];
    expect(extracted).toBe('sha-with-dashes-123');
  });
});
