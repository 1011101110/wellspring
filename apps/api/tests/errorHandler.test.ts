import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Global setErrorHandler (docs/14 §2.9 / issue #72): Fastify 5's default
 * error handler serializes `error.message` straight into the response
 * body — for an uncaught pg error (or anything else that throws
 * unexpectedly) that leaks internals to the client. This suite proves
 * the replacement handler (app.ts) never does that, regardless of what
 * the underlying error says, and always emits the same generic envelope.
 *
 * Uses a throwing route added directly to the built app instance (rather
 * than a real DB-backed failure) so this is a fast, DB-free unit test of
 * the handler itself — the pg-cast-failure REAL-WORLD trigger for this
 * bug is covered end-to-end by
 * tests/routes/session.integration.test.ts's non-UUID-token regression
 * test and tests/routes/authzProbes.integration.test.ts's param-
 * validation tests.
 */
describe('global error handler', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('never leaks the thrown error message to the client', async () => {
    app = buildApp();
    const secretDetail = 'column "users.super_secret_internal_column" does not exist';
    app.get('/__test-throws', async () => {
      throw new Error(secretDetail);
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/__test-throws' });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).not.toContain(secretDetail);
    expect(res.body).not.toContain(secretDetail);
    expect(res.body).not.toContain('super_secret_internal_column');
  });

  it('never leaks a pg-shaped error message specifically (simulated cast-failure text)', async () => {
    app = buildApp();
    // Mirrors the exact shape of the bug this issue describes: a raw pg
    // error object with a `code` and a message that echoes user input.
    app.get('/__test-throws-pg', async () => {
      const err = new Error('invalid input syntax for type uuid: "abc"') as Error & { code?: string };
      err.code = '22P02';
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/__test-throws-pg' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('invalid input syntax for type uuid');
    expect(res.body).not.toContain('22P02');
    expect(res.json().error.message).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });

  it('honors an explicit statusCode on the thrown error (e.g. a deliberate 400) without leaking its message', async () => {
    app = buildApp();
    app.get('/__test-throws-400', async () => {
      const err = new Error('some deliberate validation detail') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/__test-throws-400' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.retryable).toBe(false);
    expect(res.body).not.toContain('some deliberate validation detail');
  });

  it('does not apply to routes that succeed normally', async () => {
    app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBeUndefined(); // /status's own shape, untouched by the error envelope
  });
});
