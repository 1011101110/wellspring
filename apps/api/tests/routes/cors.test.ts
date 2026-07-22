/**
 * CORS allowlist (#195).
 *
 * Found by loading the deployed web app in a browser: the API had no CORS
 * configuration whatsoever, so every `/v1` call died on `Failed to fetch`.
 * The build, the unit tests, the deploy, and even the SHA-identity check
 * added in #230 were all green against an API the browser could not talk to.
 * Nothing had needed CORS before — iOS is a native client, and the
 * server-rendered session page is same-origin.
 *
 * These tests exist because the interesting half of a CORS config is what it
 * REFUSES. `origin: true` (reflect whatever asked) would make every one of
 * these pass while leaving any site a signed-in user visits able to issue
 * credentialed requests with their bearer token. So the rejection cases are
 * the point; the acceptance case alone would happily pass against the most
 * dangerous possible configuration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

// The allowed origin now comes entirely from WEB_APP_BASE_URL (no hardcoded
// project origin in source), so the test sets a generic one and asserts the
// allowlist honours exactly it — and rejects lookalikes of it.
const WEB_ORIGIN = 'https://app.example.com';
let priorWebAppBaseUrl: string | undefined;
beforeAll(() => {
  priorWebAppBaseUrl = process.env.WEB_APP_BASE_URL;
  process.env.WEB_APP_BASE_URL = WEB_ORIGIN;
});
afterAll(() => {
  if (priorWebAppBaseUrl === undefined) delete process.env.WEB_APP_BASE_URL;
  else process.env.WEB_APP_BASE_URL = priorWebAppBaseUrl;
});

async function preflight(origin: string) {
  const app = buildApp({});
  await app.ready();
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/status',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  await app.close();
  return res;
}

async function simpleGet(origin: string) {
  const app = buildApp({});
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/status', headers: { origin } });
  await app.close();
  return res;
}

describe('CORS', () => {
  it('allows the deployed web origin — a preflight returns the origin back', async () => {
    const res = await preflight(WEB_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });

  it('allows Authorization on the allowed origin, since that is how the API authenticates', async () => {
    const res = await preflight(WEB_ORIGIN);
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('authorization');
  });

  it('does NOT echo an arbitrary origin — the guard against `origin: true`', async () => {
    const res = await simpleGet('https://evil.example');
    // The header must be absent or non-matching. Echoing the attacker's own
    // origin is precisely the failure this allowlist exists to prevent.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('does not allow a lookalike origin that merely contains the real host', async () => {
    // Substring-matching is the classic wrong implementation. This origin
    // contains the allowed host but is a different site entirely.
    const res = await simpleGet('https://app.example.com.evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://app.example.com.evil.example',
    );
  });

  it('does not enable credentialed mode — auth is a bearer header, not a cookie', async () => {
    const res = await preflight(WEB_ORIGIN);
    // `true` here would let a browser send cookies cross-origin and widen the
    // blast radius of any future allowlist mistake, for no benefit: nothing
    // in this API authenticates via cookie.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('still serves a same-origin request with no Origin header at all', async () => {
    const app = buildApp({});
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/status' });
    await app.close();
    expect(res.statusCode).toBe(200);
  });
});
