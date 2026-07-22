/**
 * `GET /v1/devotionals/search` — full-text search across the caller's own
 * past devotionals (issue #242, Epic L #236).
 *
 * "There was one about rest, a few weeks ago" is how people actually
 * remember a devotional, and until this route existed nothing in the API
 * searched devotional content at all.
 *
 * Kept in its own file rather than added to `userScoped.ts` purely for
 * merge isolation — that module is being edited concurrently for the
 * cursor-paginated history list (L5). It registers into the same
 * authenticated `/v1` scope in app.ts and follows the same conventions as
 * every route there: `requireAuth` -> validate -> repository call scoped
 * by `request.auth.userId`.
 *
 * ## Scope (deliberately small)
 *
 * Plain Postgres full-text with weighted ranking. No fuzzy matching, no
 * semantic/vector search, no result highlighting, no field operators —
 * issue #242 is explicit that plain full-text covers the "one about
 * rest" case and that anything more is post-validation polish. The two
 * pieces of real engineering here are in the migration
 * (1722000000000: Scripture references are unsearchable without
 * expansion) and in the owner-scoping, not in the matching.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DevotionalCard } from '@kairos/shared-contracts';
import { requireAuth } from '../auth/middleware.js';
import type { Repositories } from '../db/repositories/index.js';
import type {
  DevotionalSearchCursor,
  DevotionalSearchResultRow,
} from '../db/repositories/devotionalsRepository.js';

export interface DevotionalSearchRoutesDeps {
  repositories: Repositories;
}

/**
 * Upper bound on `q`. Not a security control — `plainto_tsquery` handles
 * arbitrary input safely and the value is parameterized — but a
 * multi-kilobyte query string is never a real search, and refusing it
 * keeps someone from using this endpoint to make the database do
 * unbounded tsquery work per request.
 */
const MAX_QUERY_LENGTH = 200;

/**
 * Deliberately the same values as `DEVOTIONAL_PAGE_SIZE_DEFAULT` /
 * `DEVOTIONAL_PAGE_SIZE_MAX` in userScoped.ts (issue #241). Search
 * results and history rows are the same cards rendered by the same list
 * component, so a client that sizes its pages for one and gets a
 * different page size from the other would be dealing with an
 * inconsistency that has no reason behind it.
 *
 * Not imported from that module because it does not export them, and
 * reaching into a sibling route module for a constant would couple two
 * otherwise independent files; if a third pager appears these belong in
 * shared-contracts alongside `DevotionalCardSchema`.
 */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Matches the shape `badRequest` produces in userScoped.ts. */
function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message, retryable: false },
  });
}

/**
 * Cursors are base64url-encoded JSON rather than a raw
 * `rank|date|id` string so that adding a key later cannot break older
 * clients' in-flight cursors, and so the value reads as opaque at the
 * call site — a client that tries to construct one by hand is doing
 * something this API does not promise to keep working.
 *
 * Deliberately NOT signed or encrypted. The triple contains no secret
 * (a relevance score, a date, and a devotional id the caller has just
 * been shown) and, critically, the cursor is not trusted as an
 * authorization input: it only ever narrows a result set that is already
 * owner-scoped by `user_id` in the query itself. A caller who forges a
 * cursor pointing at another user's devotional id gets nothing but a
 * differently-positioned page of their OWN devotionals, because the
 * `user_id = $1` predicate is applied independently of it.
 */
export function encodeSearchCursor(row: DevotionalSearchResultRow): string {
  return Buffer.from(
    JSON.stringify({ r: row.rank, d: row.date, i: row.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Returns `null` for anything that is not a well-formed cursor. The
 * caller treats `null` as "start from the beginning" rather than as an
 * error: a malformed cursor is far more likely to be a stale or
 * truncated value than an attack, and per the note on
 * `encodeSearchCursor` it carries no authority, so there is nothing to
 * fail closed *about*. The field shapes are still checked so a garbage
 * value cannot reach the query and surface as a pg cast error 500.
 */
function decodeSearchCursor(raw: string): DevotionalSearchCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { r, d, i } = parsed as Record<string, unknown>;
    if (typeof r !== 'string' || typeof d !== 'string' || typeof i !== 'string') return null;
    // Shape-check before these reach `::real` / `::date` / `::uuid` casts.
    if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(r)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i)) return null;
    return { rank: r, date: d, id: i };
  } catch {
    return null;
  }
}

/**
 * Search results are `DevotionalCard` — the SAME wire type `GET
 * /v1/devotionals` returns (shared-contracts, issue #241), not a
 * search-specific look-alike.
 *
 * Issue #236 asks for result rows that render identically to history
 * rows. Sharing the declared type is what makes that a compiler-checked
 * property rather than a promise: a field added to the card for the
 * history list cannot silently omit itself here, because this function
 * would stop type-checking until search returns it too.
 *
 * `rank` is deliberately NOT exposed. Its absolute value means nothing
 * to a client, and publishing it would invite clients to sort or
 * threshold on it — freezing this ranking implementation into the wire
 * contract. It leaves this module only inside the opaque cursor.
 */
function toSearchCard(row: DevotionalSearchResultRow): DevotionalCard {
  return {
    id: row.id,
    date: row.date,
    theme: row.theme,
    cardSummary: row.card_summary,
    format: row.format,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export function registerDevotionalSearchRoutes(
  app: FastifyInstance,
  deps: DevotionalSearchRoutesDeps,
): void {
  const { repositories } = deps;

  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    '/v1/devotionals/search',
    // `requireAuth` is what the default-deny boot audit (routeAudit.ts,
    // issue #80) looks for by identity in this route's preHandler chain.
    // It is necessary but NOT sufficient for this endpoint: it establishes
    // WHO is asking, while the owner-scoping that decides WHOSE rows come
    // back lives in the `user_id = $1` predicate inside
    // `searchForUser`. See that method's docstring — a search endpoint
    // fails open, not closed, if the scoping is wrong.
    { preHandler: requireAuth },
    async (request, reply) => {
      const rawQuery = request.query.q;
      if (typeof rawQuery !== 'string') {
        return badRequest(reply, 'Query parameter "q" is required');
      }

      const q = rawQuery.trim();
      if (q.length === 0) {
        // A blank query is a client bug, not an empty result: issue #242
        // specifies that CLEARING the search box restores the history
        // list, which the client does by calling GET /v1/devotionals
        // again rather than by searching for "". Returning [] here would
        // let that bug render as a permanently-empty history instead.
        return badRequest(reply, 'Query parameter "q" must not be empty');
      }
      if (q.length > MAX_QUERY_LENGTH) {
        return badRequest(reply, `Query parameter "q" must be at most ${MAX_QUERY_LENGTH} characters`);
      }

      // An out-of-range or non-numeric `limit` is clamped rather than
      // rejected — it is a tuning hint from the client, not user intent,
      // and failing a whole search over it helps nobody.
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const limit = Number.isNaN(parsedLimit)
        ? DEFAULT_LIMIT
        : Math.min(Math.max(parsedLimit, 1), MAX_LIMIT);

      const cursor = request.query.cursor ? decodeSearchCursor(request.query.cursor) : null;

      // Over-fetch by exactly one row to determine whether a further page
      // exists, without a second COUNT query. The extra row is dropped
      // before serialization and only its presence is reported.
      const rows = await repositories.devotionals.searchForUser(request.auth!.userId, q, {
        limit: limit + 1,
        cursor,
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];

      return {
        ok: true,
        data: page.map(toSearchCard),
        // `nextCursor` is null on the last page. Clients paginate by
        // following it and stop when it is null — they should not try to
        // infer the end from `data.length < limit`, which is not a
        // reliable signal for a filtered keyset scan.
        nextCursor: hasMore && lastRow ? encodeSearchCursor(lastRow) : null,
      };
    },
  );
}
