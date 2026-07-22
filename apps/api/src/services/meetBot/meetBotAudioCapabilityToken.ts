/**
 * Per-devotional capability tokens for the Meet-bot audio websocket
 * (#221 work item 4, epic #186).
 *
 * ## The problem with the token this replaces
 *
 * Until now `/meetbot/audio/:token/:devotionalId` authenticated on a single
 * global `MEETBOT_AUDIO_TOKEN`: one long-lived secret, identical for every
 * user and every devotional, embedded in a URL that we hand to **Attendee,
 * a third-party vendor**, on every dispatch. It proved one thing — "the
 * caller is Attendee" — and nothing at all about *whose* devotional the
 * caller was entitled to stream.
 *
 * So the blast radius of that one string leaking (from Attendee's logs,
 * their support tooling, a proxy, a screenshot in a vendor ticket, a
 * breach) was: stream **any** user's devotional audio, for **any**
 * devotional id, **forever**, until a human noticed and rotated a secret
 * that only exists in Secret Manager. Devotional audio is the user's
 * private spiritual content (docs/04_DATA_PRIVACY_SECURITY.md), and
 * devotional ids are UUIDs but are not themselves treated as secrets —
 * they travel in task bodies, logs, and client responses.
 *
 * ## What replaces it
 *
 * The token in the URL is now `HMAC-SHA256(MEETBOT_AUDIO_TOKEN,
 * devotionalId)`, base64url-encoded. The route recomputes it from the
 * `devotionalId` in the *same URL* and compares. The consequences:
 *
 *   - A leaked URL is a capability for **exactly one devotional**, not for
 *     the corpus. It cannot be retargeted: changing the devotionalId in the
 *     path invalidates the token, because the token is a function of it.
 *   - Combined with the durable play-once guard (#221 work item 2, the
 *     `devotionals.meetbot_played_at` column), a leaked URL is also
 *     **single-use in practice** — once that devotional has played, every
 *     later connection with that URL is refused. And it is gated by
 *     `checkMeetBotConsent`, so it stops working the moment the owner
 *     revokes.
 *   - The root secret is **never sent to Attendee**. Previously the value
 *     in Secret Manager was literally in the URL we handed over; now only a
 *     derivative is, and HMAC is not invertible.
 *
 * ## Why HMAC derivation rather than random tokens in a table
 *
 * A randomly generated token persisted per devotional would also work and
 * would additionally allow explicit revocation-by-deletion. It was not
 * chosen because it buys very little here for a real cost: another column
 * or table, another write on the dispatch path, another thing to purge, and
 * another lookup on the connect path — while the three properties above
 * already bound the damage, and the durable play-once row provides the
 * "used up" semantics that revocation would otherwise supply. HMAC
 * derivation is stateless, needs no migration, and reuses the secret that
 * is already provisioned and rotatable.
 *
 * Rotation still works exactly as before, and is now strictly better: it
 * invalidates every outstanding capability at once, since all of them are
 * derived from the rotated root.
 *
 * ## Deployment note
 *
 * `routes/internal.ts` (which mints the URL) and `routes/meetBotAudio.ts`
 * (which verifies it) ship in the same service and the same revision, so
 * there is no version-skew window. The only URLs invalidated by this change
 * are ones held by a bot that is *already in a meeting* at the instant the
 * new revision takes over — an H1a spike path, minutes long, and the
 * failure mode is a bot that goes quiet rather than one that speaks when it
 * should not. That is the right direction to fail.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Domain-separation prefix. The root secret should never be usable to
 * derive two different kinds of credential that could be confused for one
 * another; binding the string "meetbot-audio-v1" into the HMAC input means
 * any future capability derived from the same secret (with a different
 * prefix) can never collide with an audio capability, even for an
 * identical id. The `v1` also gives us a clean way to change the scheme
 * later without a secret rotation.
 */
const TOKEN_PURPOSE = 'meetbot-audio-v1';

/**
 * Derives the capability token that authorizes streaming exactly
 * `devotionalId` — and nothing else — over the audio websocket.
 *
 * base64url (not hex, not base64): the token is a **path segment**, so it
 * must survive URL construction without escaping. base64url's alphabet is
 * URL-safe by definition, and is 33% shorter than hex for the same entropy.
 */
export function deriveMeetBotAudioToken(secret: string, devotionalId: string): string {
  return createHmac('sha256', secret).update(`${TOKEN_PURPOSE}:${devotionalId}`).digest('base64url');
}

/**
 * Constant-time verification of a presented capability token.
 *
 * Why constant-time rather than `===`: an attacker who can reconnect freely
 * — and Attendee's client, or anyone who can reach this public websocket
 * endpoint, can — is in a position to mount a timing attack against a
 * short-circuiting string compare. `timingSafeEqual` removes that whole
 * class of question for the cost of one buffer allocation.
 *
 * The length check before `timingSafeEqual` is required (it throws on
 * mismatched lengths) and leaks nothing useful: the token's length is a
 * fixed property of the scheme, publicly derivable from this file, not a
 * secret.
 *
 * Returns `false` — never throws — for any malformed input, so the caller's
 * refusal path is a single branch.
 */
export function verifyMeetBotAudioToken(
  secret: string,
  devotionalId: string,
  presentedToken: string,
): boolean {
  const expected = Buffer.from(deriveMeetBotAudioToken(secret, devotionalId), 'utf8');
  const presented = Buffer.from(presentedToken, 'utf8');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
