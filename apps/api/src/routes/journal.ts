/**
 * Journal routes (N9, #268) — extracted from userScoped.ts (#343), same
 * scope and conventions; registered by `registerUserScopedRoutes` so the
 * surface (auth, helmet, rate limit, the #80 default-deny audit) is
 * exactly what it was when these handlers lived inline there.
 *
 * A kept, user-owned place to write what one is carrying. Never sent to
 * the model (v1) — it is for the person, which also keeps the
 * prompt-injection surface closed. No route here returns a count: the
 * journal keeps words, it does not tally them (Foundation §9, ruling
 * #271).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateJournalEntryRequestSchema, UuidParamSchema, type JournalEntry } from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { JournalRepository } from '../db/repositories/journalRepository.js';

const JOURNAL_PAGE_SIZE = 20;

export interface JournalRoutesDeps {
  journal: JournalRepository;
}

const toJournalEntry = (row: { id: string; text: string; created_at: Date }): JournalEntry => ({
  id: row.id,
  text: row.text,
  createdAt: row.created_at.toISOString(),
});

/** 404, never 403 — Foundation §10 / docs/04 §5.4 (same body as userScoped.ts's notFound/invalidParam). */
function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Not found', retryable: false },
  });
}

function badRequest(reply: FastifyReply, message = 'Invalid request body') {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

export function registerJournalRoutes(app: FastifyInstance, deps: JournalRoutesDeps): void {
  const { journal } = deps;

  app.post<{ Body: unknown }>('/v1/journal', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateJournalEntryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // A real 400 here, unlike the devotionals-list query: an empty or
      // over-long entry is a genuine client error with no sensible
      // fallback reading — there is nothing to keep.
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid entry');
    }
    const row = await journal.create(request.auth!.userId, parsed.data.text);
    return reply.status(201).send({ ok: true, data: toJournalEntry(row) });
  });

  app.get<{ Querystring: { before?: string } }>(
    '/v1/journal',
    { preHandler: requireAuth },
    async (request) => {
      // `before` is a plain ISO instant cursor (the previous page's oldest
      // `createdAt`), not an opaque encoded token: the journal list is
      // ordered by one column and there is nothing to hide in the cursor,
      // so an unparseable value just means "the first page" rather than a
      // 400 that would blank the journal over a bad query string.
      const beforeRaw = request.query?.before;
      const before = beforeRaw ? new Date(beforeRaw) : undefined;
      const cursor = before && !Number.isNaN(before.getTime()) ? before : undefined;

      const { entries, hasMore } = await journal.list(
        request.auth!.userId,
        JOURNAL_PAGE_SIZE,
        cursor,
      );
      const last = entries[entries.length - 1];
      return {
        ok: true,
        data: entries.map(toJournalEntry),
        nextCursor: hasMore && last ? last.created_at.toISOString() : null,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/journal/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      // Malformed and well-formed-but-nonexistent ids are indistinguishable
      // (docs/04 §5.4) — same invalidParam-is-notFound rule as userScoped.ts.
      if (!UuidParamSchema.safeParse(request.params.id).success) return notFound(reply);
      const removed = await journal.deleteOne(request.auth!.userId, request.params.id);
      // 404 for an id that is not the caller's (or does not exist) — the
      // two are deliberately indistinguishable (§5.4, never leak
      // existence), and both correctly deleted nothing.
      if (!removed) return notFound(reply);
      return { ok: true };
    },
  );
}
