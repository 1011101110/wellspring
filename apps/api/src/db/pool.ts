import { Pool, type PoolConfig } from 'pg';

/**
 * Single shared connection pool for the process. Configuration mirrors
 * docs/06_DEPLOYMENT_CI_CD.md §1/§2: `DATABASE_URL` locally and in CI
 * (Cloud SQL Auth Proxy tunnel or docker-compose postgres); in Cloud Run,
 * `DB_SOCKET` + `DB_NAME` + `DB_PASSWORD` (unix socket to the Cloud SQL
 * proxy sidecar) when `DATABASE_URL` is not set.
 *
 * This module has no knowledge of `userId` — it is purely connection
 * plumbing. All query authorization lives in `src/db/repositories/*`.
 *
 * Ops hardening (docs/14_IMPROVEMENT_REVIEW.md §2.11 / issue #73):
 *  - `max` connections is env-driven (`DB_POOL_MAX`, default 10) rather
 *    than silently relying on `pg`'s own default — Cloud Run's default
 *    concurrency (80) is far above the previous unconfigured default, so
 *    this is deliberately explicit even though the numeric default is
 *    unchanged, to make the budget visible and tunable per-service.
 *  - `connectionTimeoutMillis: 5000` — fail fast on a stuck connection
 *    attempt instead of hanging a request indefinitely.
 *  - `statement_timeout: 15000` (ms) — bounds any single query so a
 *    runaway/locked query can't hold a pool slot forever.
 *  - `pool.on('error', ...)` — an idle client emitting an error (e.g. the
 *    backend restarting a connection) previously had no handler, which is
 *    an uncaught 'error' event on an EventEmitter and crashes the process
 *    (docs/14 §2.11: "an idle-client error crashes the process").
 */
let pool: Pool | undefined;

export function buildConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const maxConnections = Number(env.DB_POOL_MAX) || 10;
  const shared: Pick<PoolConfig, 'max' | 'connectionTimeoutMillis' | 'statement_timeout'> = {
    max: maxConnections,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  };

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl) {
    return { connectionString: databaseUrl, ...shared };
  }

  const dbSocket = env.DB_SOCKET;
  if (dbSocket) {
    return {
      host: dbSocket,
      database: env.DB_NAME,
      user: env.DB_USER ?? 'kairos_app',
      password: env.DB_PASSWORD,
      ...shared,
    };
  }

  throw new Error(
    'No database configuration found: set DATABASE_URL (local/CI) or DB_SOCKET+DB_NAME+DB_PASSWORD (Cloud Run).',
  );
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildConfig());
    // Without this handler, an 'error' emitted by an IDLE client in the
    // pool (e.g. the backing connection was reset) is an uncaught
    // EventEmitter 'error' event, which crashes the whole process — the
    // exact failure mode docs/14 §2.11 flags. Logging (not re-throwing)
    // is deliberate: the pool itself recovers by discarding the bad client
    // and creating a new one on next checkout; there's nothing else to do.
    pool.on('error', (err) => {
      console.error('[pg pool] idle client error', err);
    });
  }
  return pool;
}

/** Test/shutdown helper — closes the pool and clears the singleton. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
