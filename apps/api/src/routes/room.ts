/**
 * GET /room/:token and GET /room/:token/token — the LiveKit room-join
 * surface (D4/#32, docs/22 §2.1/§4). Public, same capability-token model
 * as /session/:token (the UUIDv4 token IS the credential — Foundation
 * §10) — reuses `sessionService.getSessionView` for the identical
 * not-found/expired enumeration-safe behavior (docs/04 §5.4) rather than
 * re-implementing it.
 *
 * `GET /room/:token`         — HTML join page (runs the LiveKit client SDK)
 * `GET /room/:token/token`   — mints a short-lived, subscribe-only viewer
 *                              JWT scoped to this session's room. No
 *                              network call (AccessToken.toJwt() is a
 *                              local signing operation) — mirrors the
 *                              audio signed-URL's "mint only at join time,
 *                              never at generation time" policy (API spec §6).
 * `GET /room/assets/join.js` — the small connect script, served
 *                              same-origin so the room scope's CSP needs
 *                              no 'unsafe-inline'/nonce (only 'self' +
 *                              the LiveKit CDN host).
 */
import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { UuidParamSchema } from '@kairos/shared-contracts';
import type { SessionLookupResult } from '../services/session/sessionService.js';
import { renderGoneOrUnknownPage } from '../services/session/renderSessionPage.js';
import { renderRoomPage } from '../services/session/renderRoomPage.js';
import { roomNameForSessionToken } from '../services/delivery/liveKitRoomNaming.js';
import type { LiveKitConfig } from '../services/delivery/liveKitConfig.js';

export interface RoomRoutesDeps {
  /** Only `getSessionView` is used — a minimal shape (not the full `SessionService` class) keeps this route independently testable with a fake. */
  sessionService: { getSessionView(token: string): Promise<SessionLookupResult> };
  liveKitConfig: LiveKitConfig;
}

/** Viewer token lifetime — matches the audio signed-URL's 15-minute join-time window (API spec §6). */
const VIEWER_TOKEN_TTL_SECONDS = 15 * 60;

const JOIN_JS = `(function () {
  var parts = location.pathname.split('/');
  var token = parts[2];
  var statusEl = document.getElementById('room-status');
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  // Browsers block audio playback that isn't triggered by a direct user
  // gesture (confirmed live, docs/23_LIVEKIT_DELIVERY.md §1: the bot's
  // track arrived and subscribed correctly, but auto-play was silently
  // blocked with a console "could not playback audio" warning and no
  // visible error). The track is attached and played only inside this
  // button's click handler, never automatically on TrackSubscribed.
  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = '🔊 Tap to listen';
  button.style.cssText = 'display:none;font-size:1.1rem;padding:0.85rem 1.75rem;border:none;border-radius:999px;background:#3a3226;color:#faf8f5;cursor:pointer;margin:0 0 1.5rem;';
  if (statusEl && statusEl.parentNode) {
    statusEl.parentNode.insertBefore(button, statusEl.nextSibling);
  }

  var pendingTrack = null;

  function playTrack(track) {
    var el = track.attach();
    document.body.appendChild(el);
    el.play().catch(function () {});
    setStatus('Playing your devotional…');
    button.style.display = 'none';
  }

  button.addEventListener('click', function () {
    if (pendingTrack) {
      playTrack(pendingTrack);
      pendingTrack = null;
    }
  });

  fetch('/room/' + token + '/token')
    .then(function (r) {
      if (!r.ok) throw new Error('token fetch failed');
      return r.json();
    })
    .then(function (data) {
      var room = new LivekitClient.Room();
      room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track) {
        if (track.kind === 'audio') {
          pendingTrack = track;
          button.style.display = 'inline-block';
          setStatus('Your devotional is ready.');
        }
      });
      room.on(LivekitClient.RoomEvent.Disconnected, function () {
        setStatus('Session ended.');
        button.style.display = 'none';
      });
      setStatus('Connecting…');
      return room.connect(data.url, data.token);
    })
    .then(function () {
      setStatus('Connected — waiting for your devotional to start…');
    })
    .catch(function () {
      setStatus('Could not connect. Please use the plain-audio link below.');
    });
})();
`;

export function registerRoomRoutes(app: FastifyInstance, deps: RoomRoutesDeps): void {
  const { sessionService, liveKitConfig } = deps;

  app.get('/room/assets/join.js', async (_request, reply) => {
    return reply.status(200).type('application/javascript; charset=utf-8').send(JOIN_JS);
  });

  app.get<{ Params: { token: string } }>('/room/:token', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }

    const result = await sessionService.getSessionView(token);
    if (result.kind === 'not_found') {
      return reply.status(404).type('text/html; charset=utf-8').send(renderGoneOrUnknownPage());
    }

    const fallbackUrl = `${liveKitConfig.publicBaseUrl.replace(/\/+$/, '')}/session/${token}`;
    return reply.status(200).type('text/html; charset=utf-8').send(renderRoomPage({ fallbackUrl }));
  });

  app.get<{ Params: { token: string } }>('/room/:token/token', async (request, reply) => {
    const { token } = request.params;
    if (!UuidParamSchema.safeParse(token).success) {
      return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
    }

    // Re-validates independently of the page GET above — same
    // not-found/expired check, no shared request state assumed (mirrors
    // session.ts's GET and POST each validating on their own).
    const result = await sessionService.getSessionView(token);
    if (result.kind === 'not_found') {
      return reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
    }

    const roomName = roomNameForSessionToken(token);
    const at = new AccessToken(liveKitConfig.apiKey, liveKitConfig.apiSecret, {
      identity: `viewer-${token}`,
      ttl: VIEWER_TOKEN_TTL_SECONDS,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true });
    const jwt = await at.toJwt();

    return reply.status(200).send({ ok: true, url: liveKitConfig.url, token: jwt, roomName });
  });
}
