/**
 * POST /v1/stage/:token/respond route tests (EPIC V #360 / V2 #363) — fake
 * stageResponseService (the gate/engine logic is unit-tested in
 * stageResponseService.test.ts). Covers the HTTP gate matrix: UUID
 * validation, enumeration-safe 404, body validation, disabled 409, and the
 * 200 envelope pass-through.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStageRoutes } from '../../src/routes/stage.js';
import type { StageLookupResult } from '../../src/services/session/sessionService.js';
import type { OpenMomentRespondResult } from '../../src/services/stage/stageResponseService.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';

const RESPONSE_ENVELOPE = {
  outcome: 'response' as const,
  audioUrl: 'https://signed.example/clip.mp3',
  verse: { reference: 'Matthew 11:28', fetchedText: 'Come to Me...', attribution: 'BSB' },
  durations: { acknowledgmentSec: 1, verseSec: 2, framingSec: 1, totalSec: 4 },
  distressFlagged: false,
};

function buildTestApp(
  respond: (token: string, transcript: string) => Promise<OpenMomentRespondResult>,
) {
  const app = Fastify();
  const getStageView = async (): Promise<StageLookupResult> => ({ kind: 'not_found' });
  registerStageRoutes(app, { sessionService: { getStageView }, stageResponseService: { respond } });
  return app;
}

describe('POST /v1/stage/:token/respond', () => {
  it('200s with the response envelope on a valid grounded response', async () => {
    const respond = vi.fn().mockResolvedValue({ kind: 'ok', envelope: RESPONSE_ENVELOPE });
    const app = buildTestApp(respond);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: 'I am weary' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(RESPONSE_ENVELOPE);
    expect(respond).toHaveBeenCalledWith(TOKEN, 'I am weary');
  });

  it('200s with a silence envelope for an empty transcript (honored silence)', async () => {
    const respond = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', envelope: { outcome: 'silence', distressFlagged: false } });
    const app = buildTestApp(respond);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('silence');
  });

  it('404s (enumeration-safe gone page) for a malformed token — engine never consulted', async () => {
    const respond = vi.fn();
    const app = buildTestApp(respond);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stage/not-a-uuid/respond',
      payload: { transcript: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(respond).not.toHaveBeenCalled();
  });

  it('404s (identical gone page) for an unknown/expired token', async () => {
    const respond = vi.fn().mockResolvedValue({ kind: 'not_found' });
    const app = buildTestApp(respond);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('409s when the open moment is not enabled for the devotional', async () => {
    const respond = vi.fn().mockResolvedValue({ kind: 'disabled' });
    const app = buildTestApp(respond);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OPEN_MOMENT_DISABLED');
  });

  it('400s on a malformed body (missing transcript / extra fields)', async () => {
    const respond = vi.fn();
    const app = buildTestApp(respond);
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const extra = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: 'x', audioBlob: 'y' },
    });
    expect(extra.statusCode).toBe(400);
    expect(respond).not.toHaveBeenCalled();
  });

  it('is NOT registered when no stageResponseService is provided (GET-only stage keeps working)', async () => {
    const app = Fastify();
    registerStageRoutes(app, {
      sessionService: { getStageView: async () => ({ kind: 'not_found' }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stage/${TOKEN}/respond`,
      payload: { transcript: 'x' },
    });
    expect(res.statusCode).toBe(404); // route not found at all
  });
});
