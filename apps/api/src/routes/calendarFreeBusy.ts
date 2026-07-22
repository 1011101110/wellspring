/**
 * `GET /v1/calendar/freebusy` — M1 of epic M (#255), the backend for the
 * dashboard calendar view.
 *
 * Kept in its own module rather than added to `userScoped.ts` for the same
 * reason `slots.ts` and `devotionalSearch.ts` are: that file is 900+ lines
 * and under concurrent edit, and this route needs five dependencies
 * (calendar client, KMS, connections, preferences, users) that none of its
 * other handlers want. Registration is the same one-liner in `app.ts`.
 *
 * ## What this route is
 *
 * A **live proxy**. Every request reads through to Google's
 * `freebusy.query` and returns what it said. Nothing is written to the
 * database — no table, no migration, no cache column. Foundation §8 permits
 * calendar access "for free/busy computation and event insertion only", and
 * `googleCalendarClient.ts`'s header states persisting busy blocks is out
 * of bounds; #255 makes the same point as the second constraint shaping the
 * feature. The only retention anywhere in this path is the in-process TTL
 * cache, which dies with the process (`freeBusyCache.ts`).
 *
 * ## The order of the gates is the design
 *
 * Every check below is placed where it is on purpose, and the ordering is
 * the substance of the privacy posture rather than an implementation
 * detail:
 *
 *   1. `requireAuth`             — identity from the verified token only.
 *   2. range validation          — cheap, and rejects before any I/O.
 *   3. `calendar_enabled`        — #201/Foundation §8 consent gate.
 *   4. `connections` row active  — #217's connection gate.
 *   5. cache read                — after the gates, never before.
 *   6. decrypt refresh token     — after everything above.
 *   7. Google `freebusy.query`.
 *
 * Steps 3 and 4 sit **above** step 6 deliberately, mirroring
 * `generateNowOrchestrator.ts`'s calendar step: a user who has withdrawn
 * consent should not have their OAuth credential unwrapped in this
 * process's memory, not even briefly, and certainly not in order to
 * discover that we were not allowed to use it. Gating after decryption
 * would produce identical HTTP responses and would still be wrong.
 *
 * Step 5 sitting below 3 and 4 is what makes the cache revocation-safe —
 * see `freeBusyCache.ts` for the full argument. A revoked user cannot reach
 * the cache read, so a stale entry cannot be served, with no invalidation
 * hook required.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  FREEBUSY_MAX_RANGE_DAYS,
  type FreeBusyBlockDto,
  type FreeBusyData,
} from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { ConnectionsRepository } from '../db/repositories/connectionsRepository.js';
import type { PreferencesRepository } from '../db/repositories/preferencesRepository.js';
import type { UsersRepository } from '../db/repositories/usersRepository.js';
import type { GoogleCalendarClient } from '../services/calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../services/calendar/googleKmsService.js';
import { FreeBusyCache } from '../services/calendar/freeBusyCache.js';
import { parseFreeBusyRange } from '../services/calendar/freeBusyRange.js';

export interface CalendarFreeBusyRoutesDeps {
  /**
   * Narrow structural deps rather than the whole `Repositories` bag — the
   * same discipline `meetBotConsentGate.ts` applies, and for the same
   * reason: it makes this route's data access auditable at a glance (it
   * reads one preferences row, one connection row, and one user row, and
   * writes nothing) and stops a test fake from satisfying a gate through
   * some unrelated method.
   */
  preferences: Pick<PreferencesRepository, 'get'>;
  connections: Pick<ConnectionsRepository, 'findByProvider'>;
  users: Pick<UsersRepository, 'findById'>;
  kmsService: GoogleKmsService;
  /**
   * The shared client. Per-request clients are minted from it with
   * `withRefreshToken` so no OAuth token cache is ever shared between
   * users — see that method's doc on `GoogleCalendarClient`.
   */
  calendarClient: GoogleCalendarClient;
  /** Injectable so tests can supply a fake clock / tiny TTL. */
  cache?: FreeBusyCache<FreeBusyBlockDto[]>;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

export function registerCalendarFreeBusyRoutes(
  app: FastifyInstance,
  deps: CalendarFreeBusyRoutesDeps,
): void {
  const { preferences, connections, users, kmsService, calendarClient } = deps;
  const cache = deps.cache ?? new FreeBusyCache<FreeBusyBlockDto[]>();

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/calendar/freebusy',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;

      // --- Gate 2: range. Before any I/O, including the database. -------
      //
      // #255: "A client asking for a year must fail fast, not melt the
      // quota." Google documents no range cap of its own (see
      // FREEBUSY_MAX_RANGE_DAYS for the sourced finding), so an unbounded
      // request would be *accepted* upstream and the damage would show up
      // later as project-wide rate limiting. Rejecting here is the only
      // place it can be rejected.
      const parsed = parseFreeBusyRange(request.query.from, request.query.to);
      if (!parsed.ok) {
        return badRequest(reply, parsed.message);
      }
      const { timeMin, timeMax } = parsed.range;

      // The zone the range is *resolved and rendered* in — the user's
      // profile zone, never the browser's (#205, and #255's timezone
      // section). `users.timezone` defaults to 'UTC' and the fallback here
      // matches `generateNowOrchestrator`'s so the two cannot disagree
      // about which zone a given user's calendar lives in.
      const user = await users.findById(userId);
      const timeZone = user?.timezone ?? 'UTC';
      const range = { from: timeMin, to: timeMax, timeZone };

      const send = (data: FreeBusyData) => reply.send({ ok: true, data });

      // --- Gate 3: consent (#201, Foundation §8). -----------------------
      //
      // Read at request time, every request. The flag is not a UI hint that
      // hides a button; it suppresses the signal at *read* time, which is
      // the specific promise Foundation §8 records as having once been
      // written down before it was true. Returning here means no free/busy
      // read is attempted at all — asserted in the tests by observing that
      // no HTTP call to Google is made, not by observing that the flag was
      // consulted (docs/07 §3.1: "assert behaviour, not participation").
      //
      // Absent preferences row => enabled, matching
      // `generateNowOrchestrator`'s `prefsRow?.calendar_enabled ?? true`.
      // Consent defaults on at signup; a missing row is a user who has
      // never touched the toggles, not a user who declined.
      const prefs = await preferences.get(userId);
      if (prefs?.calendar_enabled === false) {
        request.log.info({ userId }, 'freebusy: calendar_enabled is false — no read performed');
        return send({ status: 'consent_disabled', range });
      }

      // --- Gate 4: connection (#217's posture). -------------------------
      //
      // Compared positively against 'active' rather than `!== 'revoked'`,
      // so any future status value fails closed instead of silently
      // permitting — the reasoning is spelled out on
      // `meetBotConsentGate.ts`'s `connection_revoked`.
      //
      // #255 requires this be "a distinct, non-error response the UI can
      // render as 'connect to see your calendar', not a 500". It is
      // distinct from `consent_disabled` because the two have different
      // remedies: this one needs the OAuth flow, that one needs a toggle.
      const connection = await connections.findByProvider(userId, 'google_calendar');
      if (!connection || connection.status !== 'active') {
        return send({ status: 'not_connected', range });
      }

      // --- Gate 5: cache. Strictly below the gates above. ---------------
      //
      // Unreachable for a user who has revoked either signal, which is what
      // makes a stale entry unservable rather than merely short-lived. Also
      // a latency optimization only: Cloud Run runs several instances and
      // this map is in one of them, so a hit is luck. Correctness lives in
      // the read-through below. (freeBusyCache.ts, full argument.)
      const cacheKey = { userId, timeMin, timeMax };
      const cached = cache.get(cacheKey);
      if (cached) {
        return send({ status: 'ok', range, busy: cached });
      }

      try {
        // --- Gate 6: decrypt, only now. -------------------------------
        const refreshToken = await kmsService.decryptToken(connection.encrypted_refresh_token);
        const userCalendarClient = calendarClient.withRefreshToken(refreshToken);

        // --- Gate 7: the live read. -----------------------------------
        // Returns start/end only. Not because we filter it — because
        // `freebusy.query` has nothing else in it. Epic #255: "The
        // constraint is the feature."
        const busy = await userCalendarClient.getFreeBusyBlocks({
          timeMin,
          timeMax,
          timeZone,
        });

        const blocks: FreeBusyBlockDto[] = busy.map((b) => ({ start: b.start, end: b.end }));
        cache.set(cacheKey, blocks);
        return send({ status: 'ok', range, busy: blocks });
      } catch (err) {
        // An upstream failure is NOT one of the degraded 200s. The three
        // `status` values all mean "the system behaved correctly and here
        // is why your calendar is empty"; this means "we do not know what
        // your calendar looks like", and dressing it as `busy: []` would
        // render a user's packed day as wide open. 502 sends the client to
        // its error path, which is the honest destination.
        //
        // `retryable: true` because the realistic causes — Google 5xx, a
        // 429 against the per-user 600/min quota, a transient network
        // failure — all clear on their own.
        request.log.error({ err, userId }, 'freebusy: upstream Google Calendar read failed');
        return reply.status(502).send({
          ok: false,
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Could not read your calendar right now. Please try again.',
            retryable: true,
          },
        });
      }
    },
  );
}

export { FREEBUSY_MAX_RANGE_DAYS };
