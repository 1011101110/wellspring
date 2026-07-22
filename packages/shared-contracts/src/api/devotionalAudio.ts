import { z } from 'zod';

/**
 * `GET /v1/devotionals/:id/audio` response (issue #241, EPIC L #236) —
 * the *replay* path for the dashboard's devotional history.
 *
 * WHY this exists as its own endpoint rather than reusing the join link:
 * `/session/:token` is a capability-token surface whose row carries
 * `expires_at = event-end + 48h` (generateNowOrchestrator's
 * `SESSION_EXPIRY_MS`), and `SessionService.getSessionView` 404s the
 * instant that passes — so a devotional from last Tuesday is
 * structurally unreachable through the link the user was originally
 * sent, even though its text is retained "until account deletion" and
 * its audio for 14 days (docs/04 §2 retention row, purgeJobs.ts). The
 * fix is NOT to lengthen capability-token lifetimes: those were
 * deliberately short-lived and are the exact surface issue #79 (token
 * redaction) and the session-token scoping were built to contain.
 * Instead the caller proves ownership with Firebase auth, exactly as
 * `GET /v1/devotionals/:id` already does, and gets audio access minted
 * fresh for that request.
 *
 * `url` is therefore short-lived by construction and MUST NOT be
 * persisted or cached by a client beyond `expiresAt` — it is a GCS V4
 * signed URL (API spec §6: "15-min expiry, at session-join time — never
 * at generation time, never stored"). `expiresAt` is returned so the
 * client can re-request rather than discover expiry as a mid-playback
 * failure.
 */
export const DevotionalAudioResponseDataSchema = z.object({
  /** Freshly minted, short-lived playback URL. Never stored server-side; never valid past `expiresAt`. */
  url: z.string().min(1),
  /** ISO-8601 instant at which `url` stops working — see API spec §6's 15-minute default. */
  expiresAt: z.string().datetime({ offset: true }),
});
export type DevotionalAudioResponseData = z.infer<typeof DevotionalAudioResponseDataSchema>;

export const DevotionalAudioResponseSchema = z.object({
  ok: z.literal(true),
  data: DevotionalAudioResponseDataSchema,
});
export type DevotionalAudioResponse = z.infer<typeof DevotionalAudioResponseSchema>;

/**
 * Error code returned (inside the standard `ErrorEnvelopeSchema`, with
 * HTTP 404) when the devotional exists and belongs to the caller but its
 * audio does not — retention purged it (14 days, purgeJobs.ts /
 * docs/04 §2), or it was never synthesized (Foundation §4.5
 * AUDIO_UNAVAILABLE, the same degradation the session page renders as
 * "the audio is resting today").
 *
 * WHY a distinct code rather than a bare NOT_FOUND: on this endpoint
 * ownership is already proven, so distinguishing "no such devotional"
 * from "no audio for it" leaks nothing (contrast docs/04 §5.4, which is
 * about not confirming the existence of resources the caller does NOT
 * own — that case still returns a plain NOT_FOUND here). The client
 * needs the difference: AUDIO_UNAVAILABLE means "render the transcript,
 * hide the player", while NOT_FOUND means "this row is gone, drop it
 * from the list". Collapsing both into one code is what produces the
 * broken player #241 must avoid.
 */
export const DEVOTIONAL_AUDIO_UNAVAILABLE_CODE = 'AUDIO_UNAVAILABLE';
