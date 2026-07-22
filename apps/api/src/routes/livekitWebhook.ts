/**
 * POST /livekit/webhook — LiveKit Cloud calls this on room lifecycle
 * events (D4/#32, docs/22 §2.1/§4). Auth is LiveKit's own webhook
 * signature (`WebhookReceiver`), verified against the RAW request body —
 * NOT our `INTERNAL_API_TOKEN` shared-secret scheme (routes/internal.ts)
 * — this is a third-party-signed callback, not a server-to-server trigger
 * we control the caller of.
 *
 * On a real (non-bot) participant's `participant_joined`: acks 200
 * immediately (LiveKit expects a prompt response), THEN — after the
 * response has been sent — resolves the room back to a session and
 * publishes its devotional audio (publishDevotionalAudioToRoom.ts). That
 * work spans the full audio duration and must never block the ack; a
 * failure is logged, never thrown back at LiveKit (which would just
 * retry the webhook). See the inline comment at the dispatch check for
 * why this fires on `participant_joined` rather than the originally
 * assumed `room_started` — confirmed against a real live delivery.
 *
 * Encapsulated in its own Fastify child scope so the raw-body content-type
 * parser below (needed for signature verification) doesn't leak onto any
 * other route.
 */
import type { FastifyInstance } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { LiveKitConfig } from '../services/delivery/liveKitConfig.js';
import {
  BOT_IDENTITY,
  publishDevotionalAudioForRoom,
  type PublishDevotionalAudioDeps,
} from '../services/livekit/publishDevotionalAudioToRoom.js';

export interface LiveKitWebhookRoutesDeps {
  liveKitConfig: LiveKitConfig;
  sessionService: PublishDevotionalAudioDeps['sessionService'];
  /** Injectable for tests. Defaults to a real `WebhookReceiver`. */
  webhookReceiver?: {
    receive(
      body: string,
      authHeader?: string,
    ): Promise<{ event: string; room?: { name?: string }; participant?: { identity?: string } }>;
  };
  logger?: PublishDevotionalAudioDeps['logger'];
  /**
   * Injectable so tests can observe/await the fire-and-forget publish
   * work instead of racing it. Defaults to `publishDevotionalAudioForRoom`.
   */
  publish?: typeof publishDevotionalAudioForRoom;
}

/** LiveKit's own outgoing Content-Type for webhook deliveries. */
const WEBHOOK_CONTENT_TYPE = 'application/webhook+json';

export function registerLiveKitWebhookRoutes(app: FastifyInstance, deps: LiveKitWebhookRoutesDeps): void {
  app.register(async (webhookScope) => {
    const receiver =
      deps.webhookReceiver ?? new WebhookReceiver(deps.liveKitConfig.apiKey, deps.liveKitConfig.apiSecret);
    const publish = deps.publish ?? publishDevotionalAudioForRoom;

    // Signature verification needs the exact raw bytes LiveKit signed —
    // Fastify's default JSON parser would re-serialize and break that.
    webhookScope.addContentTypeParser(WEBHOOK_CONTENT_TYPE, { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    webhookScope.post('/livekit/webhook', async (request, reply) => {
      const authHeader = request.headers.authorization;
      const rawBody = typeof request.body === 'string' ? request.body : '';

      let event: { event: string; room?: { name?: string }; participant?: { identity?: string } };
      try {
        event = await receiver.receive(rawBody, authHeader);
      } catch (err) {
        request.log.warn({ err }, 'LiveKit webhook signature verification failed');
        return reply.status(401).send({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature', retryable: false } });
      }

      // Ack immediately — the publish work below spans the full audio
      // duration and must not delay LiveKit's expected prompt response.
      reply.status(200).send({ ok: true });

      // Dispatch trigger: `participant_joined`, not `room_started`.
      //
      // ⚠️ Corrected during live verification (docs/23_LIVEKIT_DELIVERY.md
      // §1): the original design assumed `room_started` would fire, based
      // on LiveKit's *agent-dispatch* protocol ("agents can dispatch on
      // room join" — docs/09 §1b) — but that dispatch mechanism is
      // internal to LiveKit's worker-registration system, NOT the webhook
      // event stream. A real webhook delivery against this project only
      // ever sent `participant_joined`/`participant_left`; `room_started`
      // never arrived. `participant_joined` is arguably the better
      // trigger anyway — it's the actual signal a human is present and
      // ready to listen, whereas `room_started` could in principle fire
      // before any real viewer connects.
      //
      // Guard: the bot's OWN join also produces a `participant_joined`
      // event once it connects and publishes — without the identity
      // check below, that event would recursively trigger a second
      // publish attempt into the same room.
      if (
        event.event !== 'participant_joined' ||
        !event.room?.name ||
        event.participant?.identity === BOT_IDENTITY
      ) {
        return;
      }
      const roomName = event.room.name;

      // Fire-and-forget: intentionally not awaited before the response
      // above was sent. Errors are handled and logged inside
      // publishDevotionalAudioForRoom itself; this catch is a last-resort
      // backstop against a truly unexpected throw.
      publish(roomName, {
        sessionService: deps.sessionService,
        liveKitConfig: deps.liveKitConfig,
        logger: deps.logger,
      }).catch((err) => {
        request.log.error({ err, roomName }, 'Unexpected error publishing devotional audio to room');
      });
    });
  });
}
