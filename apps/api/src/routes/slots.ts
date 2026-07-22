/**
 * POST /v1/slots — EventKit candidate-slots upload (docs/03 §8.1, docs/14
 * §4.1 step 3, issue #74). Kept in its own route module rather than added
 * to userScoped.ts to minimize collision surface with concurrent work on
 * that file; registration still happens the same way
 * (`registerSlotsRoutes(app, deps)`), so wiring it into app.ts later is a
 * one-line addition alongside the other `register*Routes` calls.
 *
 * Same authz/validation conventions as userScoped.ts: `requireAuth`,
 * Zod-validated body, scoped by `request.auth.userId`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SlotsUploadRequestSchema } from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { CandidateSlotsRepository } from '../db/repositories/index.js';

export interface SlotsRoutesDeps {
  candidateSlots: CandidateSlotsRepository;
}

function badRequest(reply: FastifyReply, message = 'Invalid request body') {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

export function registerSlotsRoutes(app: FastifyInstance, deps: SlotsRoutesDeps): void {
  const { candidateSlots } = deps;

  app.post<{ Body: unknown }>('/v1/slots', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = SlotsUploadRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply);

    const { date, slots } = parsed.data;
    const rows = await candidateSlots.replaceForDate(
      request.auth!.userId,
      date,
      slots.map((s) => ({ startAt: new Date(s.startIso), endAt: new Date(s.endIso) })),
    );
    return { ok: true, data: { date, count: rows.length } };
  });
}
