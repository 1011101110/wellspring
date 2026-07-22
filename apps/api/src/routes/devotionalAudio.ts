/**
 * `GET /v1/devotionals/:id/audio` — authenticated devotional REPLAY
 * (EPIC L, issue #236; issue #241's dashboard "tap a past devotional to
 * play it again").
 *
 * ── Why this route had to exist ──────────────────────────────────────
 * Before it, replaying an old devotional was structurally impossible,
 * and not because of the signed URL's 15-minute expiry (that URL is
 * already minted fresh on every render — sessionService.ts calls
 * `audioStorage.getSignedUrl` inside `getSessionView`, never reading a
 * stored one). The blocker was one layer up: the only surface that mints
 * it is `/session/:token`, and `SessionService.getSessionView` returns
 * `not_found` the moment `session.expires_at <= now`. That column is set
 * to event-end + 48h (`SESSION_EXPIRY_MS`, generateNowOrchestrator.ts),
 * so any devotional older than two days is unreachable through the link
 * the user was originally sent — while its text is retained until
 * account deletion and its audio for 14 days (docs/04 §2 retention row,
 * services/retention/purgeJobs.ts). The content outlives the only door
 * to it by roughly five days.
 *
 * ── Why not just extend the capability token ─────────────────────────
 * Lengthening `expires_at` would make a bearer URL — one that has been
 * mailed, pushed, and pasted into calendar invites, with no auth on it
 * whatsoever (routes/session.ts: "the UUIDv4 token itself is the
 * credential") — long-lived. That is precisely the surface issue #79
 * (token redaction in logs) and the session scope's token+IP rate
 * limiting were built to contain, and docs/04 §5.1's 48h window is a
 * deliberate blast-radius cap, not an oversight. So replay is instead
 * built on the identity the caller already has: Firebase auth, the same
 * `requireAuth` + owner-scoped `devotionals.getById(userId, id)` pair
 * that `GET /v1/devotionals/:id` uses, with audio access minted fresh
 * per authenticated request and nothing persisted.
 *
 * ── Why a separate route file ────────────────────────────────────────
 * Registered in app.ts's `apiScope` alongside `registerUserScopedRoutes`
 * so it inherits that scope's helmet config, IP-keyed rate limit, and
 * `requireAuth` conventions. It lives here rather than in userScoped.ts
 * purely to keep the audio concern (and its `AudioStorage` dependency,
 * which the rest of that file only needs for account deletion) in one
 * readable place.
 *
 * ── Replay must not mutate session state ─────────────────────────────
 * Deliberately, this route touches `sessions` not at all. Reopening a
 * devotional through the dashboard must not look like a *join*: the
 * session page's `getSessionView` records `joined_at` (issue #84,
 * join-rate metrics for PRD §8's "60% of placed devotionals joined"),
 * and POSTing its form fires the F8 Gloo engagement summary and records
 * a prayer intention (issue #86 / #93). Re-listening on Friday to
 * Tuesday's devotional is not a Tuesday join and is not a second
 * completion; routing replay through the session surface would have
 * corrupted both metrics. Reading history here is a pure read.
 *
 * ── Retention: fail cleanly, never 500 ───────────────────────────────
 * Three distinct "no audio" cases all resolve to one calm 404 carrying
 * `AUDIO_UNAVAILABLE` (Foundation §4.5): `audio_object` is NULL (never
 * synthesized, or nulled by the purge job), the object is gone from
 * storage (the GCS bucket's own 14-day lifecycle rule can delete it
 * before the job runs — docs/06 §1.4, the skew issue #82 called out),
 * and `getSignedUrl` throwing. A devotional the caller does not own, or
 * that does not exist, returns a plain `NOT_FOUND` instead — 404 in both
 * cases, never 403, so a foreign id is indistinguishable from a
 * nonexistent one (Foundation §10 / docs/04 §5.4 IDOR posture).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DEVOTIONAL_AUDIO_UNAVAILABLE_CODE,
  UuidParamSchema,
  type DevotionalAudioResponse,
} from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AudioStorage, SignedUrlOptions } from '../services/audio/audioStorage.js';

export interface DevotionalAudioRoutesDeps {
  repositories: Repositories;
  audioStorage: AudioStorage;
  /**
   * Passed straight through to `AudioStorage.getSignedUrl`. Left
   * undefined in production so the API-spec §6 default (15 minutes)
   * applies — this exists so tests can pin an expiry and assert on it
   * without reaching into the storage implementation.
   */
  signedUrlOptions?: SignedUrlOptions;
}

/**
 * 404, never 403 — same helper semantics as userScoped.ts's `notFound`,
 * duplicated rather than exported across files because it is three lines
 * and the alternative is a shared module whose only purpose is to hold
 * two response literals.
 */
function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Not found', retryable: false },
  });
}

/** The devotional is the caller's, but its audio isn't available — see the file header's retention section for the three ways this happens. */
function audioUnavailable(reply: FastifyReply) {
  return reply.status(404).send({
    ok: false,
    error: {
      code: DEVOTIONAL_AUDIO_UNAVAILABLE_CODE,
      message: 'Audio is not available for this devotional',
      // Not retryable: every path into here is terminal (purged, never
      // synthesized, or lifecycle-deleted). Telling a client to retry
      // would produce a spin loop against a file that is never coming back.
      retryable: false,
    },
  });
}

export function registerDevotionalAudioRoutes(
  app: FastifyInstance,
  deps: DevotionalAudioRoutesDeps,
): void {
  const { repositories, audioStorage, signedUrlOptions } = deps;

  app.get<{ Params: { id: string } }>(
    '/v1/devotionals/:id/audio',
    { preHandler: requireAuth },
    async (request, reply) => {
      // Shape-check before the repository query: a non-UUID string
      // reaching a `uuid`-typed column throws a pg cast error that would
      // surface as a 500, which is both a Postgres-internals leak and
      // distinguishable from this route's normal 404 (docs/14 §2.9,
      // issue #72 — the same reasoning as routes/session.ts).
      if (!UuidParamSchema.safeParse(request.params.id).success) return notFound(reply);

      // Ownership check and existence check in one query: `getById` is
      // `WHERE user_id = $1 AND id = $2`, so another user's devotional
      // returns null here and falls into the identical 404 a nonexistent
      // id gets. This is the whole authorization story for this route —
      // there is no path to `getSignedUrl` below that skips it.
      const devotional = await repositories.devotionals.getById(
        request.auth!.userId,
        request.params.id,
      );
      if (!devotional) return notFound(reply);

      if (!devotional.audio_object) return audioUnavailable(reply);

      try {
        // `exists` before `getSignedUrl` because a signed URL for a
        // deleted object is happily mintable and only fails at playback
        // time, as a 404 inside an <audio> element the user experiences
        // as a dead player — exactly the failure mode #241 asks us to
        // avoid. Checking here converts it into a clean, typed response
        // the client can render as "transcript only".
        if (!(await audioStorage.exists(devotional.id))) return audioUnavailable(reply);

        const signed = await audioStorage.getSignedUrl(devotional.id, signedUrlOptions);
        const body: DevotionalAudioResponse = {
          ok: true,
          data: { url: signed.url, expiresAt: signed.expiresAt.toISOString() },
        };
        return reply.status(200).send(body);
      } catch {
        // A storage/credentials failure degrades to AUDIO_UNAVAILABLE
        // rather than 500 (Foundation §4.5) — the same choice
        // sessionService.getSessionView makes when signing throws. The
        // error is deliberately not echoed: it can carry bucket names and
        // credential details (docs/14 §2.9).
        return audioUnavailable(reply);
      }
    },
  );
}
