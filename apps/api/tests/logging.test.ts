import { describe, it, expect } from 'vitest';
import { redactCapabilityToken } from '../src/app.js';

/**
 * docs/14_IMPROVEMENT_REVIEW.md §2.1 / issue #79: `/session/:token` and
 * `/audio/:token` carry a bearer-style capability credential in the URL
 * path. This proves the request-log serializer's redaction regex masks
 * exactly that segment and nothing else.
 */
describe('redactCapabilityToken', () => {
  it('redacts a session token', () => {
    expect(redactCapabilityToken('/session/abc123.def456')).toBe('/session/<redacted>');
  });

  it('redacts an audio token', () => {
    expect(redactCapabilityToken('/audio/abc123.def456')).toBe('/audio/<redacted>');
  });

  it('redacts a stage token, including its ?mute=1 variant (Q2 #332 — same credential as /session)', () => {
    expect(redactCapabilityToken('/stage/00000000-0000-4000-8000-000000000001')).toBe(
      '/stage/<redacted>',
    );
    expect(redactCapabilityToken('/stage/00000000-0000-4000-8000-000000000001?mute=1')).toBe(
      '/stage/<redacted>?mute=1',
    );
  });

  it('redacts a long base64url-with-dots signed token', () => {
    const token =
      'eyJvYmplY3RLZXkiOiJkZXZvdGlvbmFscy9kZXYtYS5tcDMifQ.q9diMHsva4COwRJXG4iyo38TINZPKC8HRwxiGvN6z9k';
    expect(redactCapabilityToken(`/audio/${token}`)).toBe('/audio/<redacted>');
  });

  it('preserves a query string after the token (redacts only the path segment)', () => {
    expect(redactCapabilityToken('/session/abc123?foo=bar')).toBe('/session/<redacted>?foo=bar');
  });

  it('leaves unrelated routes untouched', () => {
    expect(redactCapabilityToken('/v1/preferences')).toBe('/v1/preferences');
    expect(redactCapabilityToken('/status')).toBe('/status');
    expect(redactCapabilityToken('/v1/connect/google/callback?code=x&state=y')).toBe(
      '/v1/connect/google/callback?code=x&state=y',
    );
  });

  it('does not redact a bare /session or /audio with no token segment', () => {
    expect(redactCapabilityToken('/session')).toBe('/session');
    expect(redactCapabilityToken('/session/')).toBe('/session/');
  });

  it('only redacts the token at the start of the path (not a substring match elsewhere)', () => {
    expect(redactCapabilityToken('/v1/session/abc123')).toBe('/v1/session/abc123');
  });
});
