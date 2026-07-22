/**
 * Unit tests for the per-devotional audio capability token (#221).
 *
 * The properties under test are the ones the security argument in
 * services/meetBot/meetBotAudioCapabilityToken.ts actually rests on — a
 * leaked URL is scoped to one devotional, cannot be retargeted, and does
 * not reveal the root secret. Testing "it returns a string" would not
 * defend any of that.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveMeetBotAudioToken,
  verifyMeetBotAudioToken,
} from '../../../src/services/meetBot/meetBotAudioCapabilityToken.js';

const SECRET = 'root-secret-under-test';

describe('meetBot audio capability token', () => {
  it('verifies a token against the devotional it was minted for', () => {
    const token = deriveMeetBotAudioToken(SECRET, 'devo-1');
    expect(verifyMeetBotAudioToken(SECRET, 'devo-1', token)).toBe(true);
  });

  it('is bound to the devotional id — a token for one devotional does not open another', () => {
    // The central claim of #221 work item 4. Under the old global token,
    // this expectation was `true` for every devotional in the database.
    const token = deriveMeetBotAudioToken(SECRET, 'devo-1');
    expect(verifyMeetBotAudioToken(SECRET, 'devo-2', token)).toBe(false);
  });

  it('is bound to the root secret — a rotation invalidates every outstanding capability', () => {
    const token = deriveMeetBotAudioToken(SECRET, 'devo-1');
    expect(verifyMeetBotAudioToken('rotated-secret', 'devo-1', token)).toBe(false);
  });

  it('is deterministic, so a reconnect with the same URL still verifies', () => {
    // Attendee reconnects the audio channel throughout the bot's session
    // using the URL it was given once. A nondeterministic token would break
    // every reconnect, so this is a functional requirement, not a detail.
    expect(deriveMeetBotAudioToken(SECRET, 'devo-1')).toBe(deriveMeetBotAudioToken(SECRET, 'devo-1'));
  });

  it('does not leak the root secret into the token', () => {
    const token = deriveMeetBotAudioToken(SECRET, 'devo-1');
    expect(token).not.toContain(SECRET);
  });

  it('is URL-path safe, since the token travels as a path segment', () => {
    // base64url by construction, but asserted because a `/` or `+` here
    // would silently corrupt the route match rather than fail loudly.
    for (const id of ['devo-1', 'a', '0000-1111-2222-3333', 'x'.repeat(200)]) {
      expect(deriveMeetBotAudioToken(SECRET, id)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('returns false rather than throwing for malformed or empty presented tokens', () => {
    // The route's refusal path is a single branch; anything that threw here
    // would escape it into the generic error handler instead.
    for (const bogus of ['', 'not-a-token', '!!!', 'x'.repeat(500)]) {
      expect(verifyMeetBotAudioToken(SECRET, 'devo-1', bogus)).toBe(false);
    }
  });
});
