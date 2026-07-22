import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig, closePool, getPool } from '../../src/db/pool.js';

describe('buildConfig (docs/14 §2.11 / issue #73 — pool hardening)', () => {
  it('applies max/connectionTimeoutMillis/statement_timeout defaults for DATABASE_URL config', () => {
    const config = buildConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(config.connectionString).toBe('postgres://u:p@localhost:5432/db');
    expect(config.max).toBe(10);
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.statement_timeout).toBe(15000);
  });

  it('applies the same hardening defaults for DB_SOCKET config', () => {
    const config = buildConfig({
      DB_SOCKET: '/cloudsql/proj:region:instance',
      DB_NAME: 'kairos',
      DB_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe('/cloudsql/proj:region:instance');
    expect(config.max).toBe(10);
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.statement_timeout).toBe(15000);
  });

  it('honors DB_POOL_MAX to override the default max', () => {
    const config = buildConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DB_POOL_MAX: '25',
    } as NodeJS.ProcessEnv);
    expect(config.max).toBe(25);
  });

  it('falls back to max=10 when DB_POOL_MAX is unset/non-numeric', () => {
    const config1 = buildConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv);
    expect(config1.max).toBe(10);
    const config2 = buildConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DB_POOL_MAX: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(config2.max).toBe(10);
  });

  it('throws when neither DATABASE_URL nor DB_SOCKET is set', () => {
    expect(() => buildConfig({} as NodeJS.ProcessEnv)).toThrow(/No database configuration found/);
  });
});

describe('getPool() error handler (issue #73 — idle-client error must not crash the process)', () => {
  afterEach(async () => {
    await closePool();
    vi.unstubAllEnvs();
  });

  it('registers a pool.on("error", ...) handler so an idle-client error does not throw uncaught', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db');
    const pool = getPool();
    const errorListenerCount = pool.listenerCount('error');
    expect(errorListenerCount).toBeGreaterThanOrEqual(1);

    // Simulate what pg itself does on an idle-client error — emitting
    // 'error' with zero listeners is what crashes the process; with our
    // handler registered this must NOT throw.
    expect(() => pool.emit('error', new Error('simulated idle client error'))).not.toThrow();
  });
});
