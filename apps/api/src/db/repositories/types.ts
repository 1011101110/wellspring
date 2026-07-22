import { types, type Pool, type PoolClient } from 'pg';

// Postgres `DATE` columns (oid 1082, e.g. `daily_bands.date`) are parsed by
// `pg` as JS `Date` objects by default, which then JSON-serialize as a full
// UTC timestamp ("2026-07-04T04:00:00.000Z") instead of the plain
// "YYYY-MM-DD" every wire contract expects (`BandsUploadResponseDataSchema.date`,
// docs/00 §5) — and can silently shift the calendar day for any caller west
// of UTC. Returning the raw string instead is the standard node-postgres
// fix. `setTypeParser` registers into a process-global oid->parser table
// (not per-`Pool`), so it must live in a module every query path actually
// imports at runtime — this file qualifies because `index.ts`'s
// `export * from './types.js'` is a real (non-type-only) re-export of
// `asVerifiedUserId`, so it loads before any repository runs, in both
// production boot and every integration test's own independently
// constructed `Pool` (issue #85, caught by the `GET /v1/ledger/today`
// date-equality assertion).
types.setTypeParser(1082, (value) => value);

/**
 * A `VerifiedUserId` is a branded string — it exists to make it
 * structurally awkward to pass an arbitrary/unchecked string as the
 * scoping key into a repository method. Callers must go through
 * `asVerifiedUserId`, which is the single choke point every call site
 * routes through (e.g. after Firebase Admin SDK ID-token verification —
 * Foundation §10: "userId from the verified token — never from the
 * request body").
 *
 * This is a lightweight compile-time guard, not a runtime one — it does
 * not replace the authz integration tests (F1), but it makes "I forgot
 * to scope this query" fail `tsc` for any repository method that takes
 * this type instead of `string`.
 */
export type VerifiedUserId = string & { readonly __brand: 'VerifiedUserId' };

/**
 * The ONLY function that should produce a VerifiedUserId. Call this with
 * the `userId` claim from a verified Firebase ID token (or, in tests,
 * a UUID you inserted yourself) — never with a raw request-body field.
 */
export function asVerifiedUserId(userId: string): VerifiedUserId {
  if (!userId || typeof userId !== 'string') {
    throw new Error('asVerifiedUserId: userId must be a non-empty string');
  }
  return userId as VerifiedUserId;
}

/** Anything a repository can run a query against: the pool or a transaction client. */
export type Queryable = Pool | PoolClient;
