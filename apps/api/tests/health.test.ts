import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';

describe('GET /status', () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with status ok and an ISO8601 timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('responds with JSON content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.headers['content-type']).toContain('application/json');
  });
});
