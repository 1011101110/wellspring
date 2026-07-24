import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditV1RoutesRequireAuth } from '../../src/auth/routeAudit.js';
import { requireAuth } from '../../src/auth/middleware.js';
import { buildApp } from '../../src/app.js';

/**
 * Issue #80: a forgotten `{ preHandler: requireAuth }` on a new `/v1`
 * route must not silently ship a public route — it should crash the
 * app at boot instead. These tests exercise `auditV1RoutesRequireAuth`
 * directly against bare Fastify instances (no DB, no full `buildApp`)
 * so the invariant itself is covered in isolation; the real route
 * surface is covered by `tests/auth/middleware.test.ts` and friends,
 * which build the actual `buildApp()` and would fail `onReady` too if
 * a real route regressed.
 *
 * Deliberately awaits `app.ready()` directly rather than via
 * `expect(...).resolves`/`.rejects` — that pattern throws an unrelated
 * `Cannot read properties of undefined (reading 'family')` error in this
 * Fastify/vitest combination, independent of anything under test here.
 */
describe('auditV1RoutesRequireAuth', () => {
  it('boots cleanly when every /v1 route has requireAuth', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app);
    app.get('/v1/preferences', { preHandler: requireAuth }, async () => ({ ok: true }));
    await app.ready();
    await app.close();
  });

  it('boots cleanly when the only unprotected /v1 route is explicitly allowlisted', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app, { allowedPublicV1Routes: ['/v1/connect/google/callback'] });
    app.get('/v1/connect/google/callback', async () => ({ ok: true }));
    app.get('/v1/preferences', { preHandler: requireAuth }, async () => ({ ok: true }));
    await app.ready();
    await app.close();
  });

  it('fails onReady when a /v1 route forgets requireAuth', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app);
    app.get('/v1/oops', async () => ({ ok: true }));
    await expect(app.ready()).rejects.toThrow(/GET \/v1\/oops/);
    await app.close();
  });

  it('fails onReady even when only ONE of several /v1 routes forgets requireAuth', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app);
    app.get('/v1/preferences', { preHandler: requireAuth }, async () => ({ ok: true }));
    app.post('/v1/oops', async () => ({ ok: true }));
    await expect(app.ready()).rejects.toThrow(/POST \/v1\/oops/);
    await app.close();
  });

  it('does not flag a route outside /v1 (e.g. /status, /session/:token)', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app);
    app.get('/status', async () => ({ ok: true }));
    app.get('/session/:token', async () => ({ ok: true }));
    await app.ready();
    await app.close();
  });

  it('does not flag an allowlisted route even without requireAuth, but still flags a sibling that is not allowlisted', async () => {
    const app = Fastify();
    auditV1RoutesRequireAuth(app, { allowedPublicV1Routes: ['/v1/connect/google/callback'] });
    app.get('/v1/connect/google/callback', async () => ({ ok: true }));
    app.get('/v1/other-unprotected', async () => ({ ok: true }));
    await expect(app.ready()).rejects.toThrow(/GET \/v1\/other-unprotected/);
    await app.close();
  });
});

/**
 * Boots the REAL `buildApp()` with the route groups that only register when
 * their deps are supplied — the exact gap that shipped a boot-crashing
 * container: `POST /v1/stage/:token/respond` (EPIC V) registers only when
 * `stageRoutes.stageResponseService` is present, so every prior boot test
 * (which called `buildApp()` with no options) never exercised the audit
 * against it. Production DOES supply it, so five deploys crashed on the #80
 * audit while CI stayed green. This test closes that hole: it fails `onReady`
 * if a capability-authed `/v1` route is added without an allowlist entry.
 */
describe('buildApp boot audit — routes gated behind optional deps', () => {
  it('boots cleanly with the Open Moment respond route registered (allowlisted)', async () => {
    const app = buildApp({
      stageRoutes: {
        sessionService: { getStageView: async () => ({ kind: 'not_found' }) },
        // Presence of this dep is what registers POST /v1/stage/:token/respond.
        stageResponseService: { respond: async () => ({ outcome: 'silence' }) },
      } as never,
    });
    await app.ready();
    await app.close();
  });
});
