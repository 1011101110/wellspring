/**
 * POST /invite/inbound — Resend's inbound-email webhook receiver (Epic I,
 * issue #61, docs/12 §1.1). Ingests a user-created calendar invite that
 * named a per-user Wellspring routing address as an attendee.
 *
 * Scope (docs/12 §1.1 steps 1–3, 6 and §1.4.3): resolves the routing
 * address to a user, fetches + parses the `.ics` attachment, enforces the
 * organizer-must-match-account-owner check, then — when a `generateFromInvite`
 * hook is configured (I2/#62) — assembles the deliberate-disclosure context
 * (subject + description only, Foundation §8) and generates a real
 * devotional + session via the shared GenerateNowOrchestrator. Without the
 * hook the route stops at "ingested" (attribution-only, the pre-I2 posture).
 * Cancellations are acknowledged but never generated from.
 *
 * Auth: Resend signs webhooks via Svix (svix-id/svix-timestamp/
 * svix-signature headers over the raw body) — verified against
 * `RESEND_WEBHOOK_SECRET`, fail-closed if unset, same posture as
 * routes/internal.ts's shared-secret scheme.
 *
 * Non-error philosophy (docs/12 §1.4.3): anything that isn't a match —
 * unrecognized routing address, unknown user, missing/unparseable .ics,
 * organizer not the account owner — is a **silent decline** (logged,
 * 200 OK, no data processed), never a thrown error. Malformed inputs are
 * expected here (email is not a trusted internal caller) and must never
 * produce noisy 4xx/5xx responses that could leak which addresses are
 * valid or cause Resend to retry pointlessly.
 *
 * Live status: the inbound path is exercised against a live Resend account
 * on the `lexirdro.resend.app` receiving subdomain (I1 was live-tested).
 * Remaining #62 follow-ups: a lightweight distress classifier feeding
 * `distressSignalOverride` (the engine's elevated-care framing already
 * applies to invite context in the meantime), and replying to the invite
 * with the session link (outbound — needs a verified sending domain, I3/I7).
 */
import type { FastifyInstance } from 'fastify';
import { Webhook, WebhookVerificationError } from 'svix';
import { z } from 'zod';
import type { InboundEmailProvider } from '../services/invite/inboundEmailProvider.js';
import { parseInviteRoutingAddress } from '../services/invite/inviteRoutingAddress.js';
import { parseInboundIcs } from '../services/invite/inboundIcsParser.js';
import { buildInviteContext } from '../services/invite/inviteContext.js';
import type { DurationPreference } from '../services/gloo/instructionsBuilder.js';
import type { UsersRepository } from '../db/repositories/index.js';
import { asVerifiedUserId } from '../db/repositories/types.js';

/**
 * The generation slice of I2 (#62): what the route hands to the shared
 * GenerateNowOrchestrator for a valid, organizer-matched invite. Kept as a
 * narrow callback (not the orchestrator itself) so the route depends only
 * on the invite→generation boundary, and tests can exercise attribution
 * without a real engine. The caller (index.ts) fills in the neutral bands,
 * `skipCalendar`, and idempotency posture — this only carries what the
 * invite itself contributes.
 */
export interface InviteGenerationRequest {
  userId: string;
  /** The user's own words from the invite (subject + description), or undefined. */
  inviteContext: string | undefined;
  /** Format derived from the event's own length; undefined lets the engine pick. */
  durationPreference: DurationPreference;
}
export interface InviteGenerationOutcome {
  sessionUrl: string;
  devotionalId: string;
}

export interface InboundInviteRoutesDeps {
  /** e.g. `invite.kairos.app` — see inviteRoutingAddress.ts's ⚠️ Must-confirm note on this not yet being a real domain. */
  inviteDomain: string;
  emailProvider: InboundEmailProvider;
  users: Pick<UsersRepository, 'findById'>;
  /** Defaults to `process.env.RESEND_WEBHOOK_SECRET`. Injectable for tests. */
  webhookSecret?: string;
  /**
   * I2 (#62): turns a validated, organizer-matched invite into a real
   * devotional + session. When omitted the route stops at "ingested" (the
   * pre-I2 behavior — still used by parsing/attribution-only tests). A
   * cancellation invite is never generated from, regardless.
   */
  generateFromInvite?: (input: InviteGenerationRequest) => Promise<InviteGenerationOutcome>;
}

const ResendInboundWebhookSchema = z.object({
  type: z.literal('email.received'),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string().optional(),
  }),
});

const RAW_JSON_CONTENT_TYPE = 'application/json';

export function registerInboundInviteRoutes(app: FastifyInstance, deps: InboundInviteRoutesDeps): void {
  app.register(async (inviteScope) => {
    const webhookSecret = deps.webhookSecret ?? process.env.RESEND_WEBHOOK_SECRET;

    // Signature verification needs the exact raw bytes Resend/Svix signed —
    // same reasoning as routes/livekitWebhook.ts's raw-body parser.
    inviteScope.addContentTypeParser(RAW_JSON_CONTENT_TYPE, { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    inviteScope.post('/invite/inbound', async (request, reply) => {
      const rawBody = typeof request.body === 'string' ? request.body : '';

      if (!webhookSecret) {
        request.log.error({}, 'inboundInvite: RESEND_WEBHOOK_SECRET not configured — rejecting');
        return reply.status(401).send({ ok: false, error: { code: 'AUTH_FAILED', message: 'Webhook not configured', retryable: false } });
      }

      let verifiedPayload: unknown;
      try {
        verifiedPayload = new Webhook(webhookSecret).verify(rawBody, {
          'svix-id': String(request.headers['svix-id'] ?? ''),
          'svix-timestamp': String(request.headers['svix-timestamp'] ?? ''),
          'svix-signature': String(request.headers['svix-signature'] ?? ''),
        });
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          request.log.error({ err: err.message }, 'inboundInvite: webhook signature verification failed');
          return reply.status(401).send({ ok: false, error: { code: 'AUTH_FAILED', message: 'Invalid signature', retryable: false } });
        }
        throw err;
      }

      const parsed = ResendInboundWebhookSchema.safeParse(verifiedPayload);
      if (!parsed.success) {
        // Not our expected shape (e.g. a different Resend event type
        // delivered to the same endpoint) — not an error, just not for us.
        request.log.info({}, 'inboundInvite: payload did not match email.received shape — ignoring');
        return reply.status(200).send({ ok: true, ingested: false, reason: 'unrecognized_payload' });
      }

      const { email_id: emailId, from, to } = parsed.data.data;

      const userId = to
        .map((address) => parseInviteRoutingAddress(address, deps.inviteDomain))
        .find((id): id is string => id !== null);
      if (!userId) {
        request.log.info({ to }, 'inboundInvite: no recipient matched our routing scheme — declining silently');
        return reply.status(200).send({ ok: true, ingested: false, reason: 'no_routing_match' });
      }

      const user = await deps.users.findById(asVerifiedUserId(userId));
      if (!user) {
        request.log.info({ userId }, 'inboundInvite: routing address userId does not resolve to a real user — declining silently');
        return reply.status(200).send({ ok: true, ingested: false, reason: 'unknown_user' });
      }

      let icsText: string | null;
      try {
        icsText = await deps.emailProvider.fetchIcsAttachment(emailId);
      } catch (err) {
        // A provider-side fetch failure (auth misconfiguration, rate
        // limit, transient network error) is not the sender's fault and
        // not evidence of anything suspicious — same non-error philosophy
        // as every other branch here, just triggered by our own
        // infrastructure instead of the inbound content.
        request.log.error(
          { userId, emailId, err: err instanceof Error ? err.message : String(err) },
          'inboundInvite: fetching the .ics attachment failed — declining silently',
        );
        return reply.status(200).send({ ok: true, ingested: false, reason: 'attachment_fetch_failed' });
      }
      if (!icsText) {
        request.log.info({ userId, emailId }, 'inboundInvite: no .ics attachment found — declining silently');
        return reply.status(200).send({ ok: true, ingested: false, reason: 'no_ics_attachment' });
      }

      let invite;
      try {
        invite = await parseInboundIcs(icsText);
      } catch (err) {
        request.log.info(
          { userId, emailId, err: err instanceof Error ? err.message : String(err) },
          'inboundInvite: .ics attachment failed to parse — declining silently',
        );
        return reply.status(200).send({ ok: true, ingested: false, reason: 'unparseable_ics' });
      }

      // docs/12 §1.4.3: only the account owner's own invites are honored.
      // Match against the ICS ORGANIZER (the actual calendar-level
      // originator) rather than the envelope `from` address, which can
      // differ (e.g. calendar-provider relay addresses).
      const accountEmail = user.email?.toLowerCase() ?? null;
      if (!accountEmail || !invite.organizerEmail || invite.organizerEmail !== accountEmail) {
        request.log.info(
          { userId, organizerEmail: invite.organizerEmail, from },
          'inboundInvite: organizer does not match account owner — declining silently',
        );
        return reply.status(200).send({ ok: true, ingested: false, reason: 'organizer_mismatch' });
      }

      // A cancellation carries no words to build a devotional from, and
      // there is no scheduled Wellspring-side event to tear down in this path
      // (real-meeting join is I5/#65). Acknowledge and stop.
      if (invite.isCancellation) {
        request.log.info(
          { userId, uid: invite.uid },
          'inboundInvite: ingested a cancellation — nothing to generate',
        );
        return reply.status(200).send({ ok: true, ingested: true, generated: false, reason: 'cancellation' });
      }

      // I2 (#62): the deliberate-disclosure boundary — subject + description
      // ONLY become generation context (Foundation §8); duration comes from
      // the event's own length. buildInviteContext is the single tested
      // choke point for that rule.
      const { context: inviteContext, durationPreference } = buildInviteContext(invite);

      // Pre-I2 posture (or a deploy without the generation hook wired):
      // stop at "ingested". Still exercised by attribution-only tests.
      if (!deps.generateFromInvite) {
        request.log.info(
          { userId, uid: invite.uid, hasMeetingUrl: invite.meetingUrl !== null },
          'inboundInvite: ingested a valid invite (generation hook not configured)',
        );
        return reply.status(200).send({ ok: true, ingested: true, generated: false });
      }

      // Generate. A failure here is still a silent, retry-free decline
      // (docs/12 §1.4.3): the webhook must never 5xx and make Resend retry.
      try {
        const outcome = await deps.generateFromInvite({ userId, inviteContext, durationPreference });
        request.log.info(
          { userId, uid: invite.uid, devotionalId: outcome.devotionalId, hasContext: inviteContext !== undefined, durationPreference },
          'inboundInvite: generated a devotional from a valid invite (I2)',
        );
        return reply.status(200).send({ ok: true, ingested: true, generated: true, devotionalId: outcome.devotionalId });
      } catch (err) {
        request.log.error(
          { userId, uid: invite.uid, err },
          'inboundInvite: generation failed — declining silently (no retry)',
        );
        return reply.status(200).send({ ok: true, ingested: true, generated: false, reason: 'generation_failed' });
      }
    });
  });
}
