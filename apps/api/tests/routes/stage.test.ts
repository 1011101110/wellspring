/**
 * GET /stage/:token route tests — Q2 (#332) + Q3 (#333). Fake
 * sessionService per the room.ts test pattern; the deps shape only admits
 * the READ-ONLY getStageView, so the no-write rule is structural (see
 * also tests/services/session/stageView.test.ts for the service-level
 * markJoined assertions).
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { buildApp } from '../../src/app.js';
import { registerStageRoutes } from '../../src/routes/stage.js';
import type { SessionService, StageLookupResult } from '../../src/services/session/sessionService.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';
const OTHER_TOKEN = '00000000-0000-4000-8000-000000000002';

const OK_VIEW: StageLookupResult = {
  kind: 'ok',
  page: {
    token: TOKEN,
    completed: false,
    audioUrl: 'https://storage.googleapis.com/bucket/devo.mp3?sig=x',
    devotional: {
      theme: 'Rest for the weary',
      format: 'short',
      verses: [
        {
          usfm: 'MAT.11.28',
          reference: 'Matthew 11:28-30',
          fetchedText: 'Come to me, all you who are weary and burdened, and I will give you rest.',
          attribution: 'Berean Standard Bible (BSB). Public domain.',
        },
      ],
      devotionalBody: 'A steady word about rest.',
      prayer: 'Lord, grant me rest. Amen.',
      journalingPrompt: 'Where did you find rest today?',
      actionStep: 'Take five unhurried minutes outside.',
    },
  },
  manifest: [
    { section: 'greeting', startSec: 0, endSec: 2, text: 'A moment of Rest for the weary.' },
    { section: 'scripture', startSec: 2, endSec: 10, text: 'From Matthew 11:28-30. Come to me.' },
    { section: 'reflection', startSec: 10, endSec: 25, text: 'A steady word about rest.' },
    { section: 'prayer', startSec: 25, endSec: 32, text: 'Lord, grant me rest. Amen.' },
  ],
};

function buildTestApp(getStageView: (token: string) => Promise<StageLookupResult>) {
  const app = Fastify();
  registerStageRoutes(app, { sessionService: { getStageView } });
  return app;
}

describe('GET /stage/:token', () => {
  it('renders all four tab pills, the verse, attribution line, inlined manifest, and the signed audio URL', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    for (const pill of ['Scripture', 'Reflection', 'Questions', 'Prayer']) {
      expect(res.body).toContain(pill);
    }
    expect(res.body).toContain('Come to me, all you who are weary');
    expect(res.body).toContain('Matthew 11:28-30');
    expect(res.body).toContain('Berean Standard Bible (BSB)');
    // Manifest inlined as a non-executable JSON block — no extra fetch.
    expect(res.body).toContain('<script type="application/json" id="stage-data">');
    expect(res.body).toContain('"section":"greeting"');
    // Audio: autoplay, signed URL, NOT muted by default.
    expect(res.body).toContain('id="stage-audio" autoplay');
    expect(res.body).toContain('https://storage.googleapis.com/bucket/devo.mp3?sig=x');
    expect(res.body).not.toContain(' muted');
    // Page JS served same-origin (CSP script-src 'self').
    expect(res.body).toContain('/stage/assets/stage.js');
  });

  it('formats without journaling/action fields render three tabs — the QUESTIONS pill and panel are absent', async () => {
    const noQuestions: StageLookupResult = {
      ...OK_VIEW,
      page: {
        ...OK_VIEW.page,
        devotional: { ...OK_VIEW.page.devotional, journalingPrompt: null, actionStep: null },
      },
    } as StageLookupResult;
    const app = buildTestApp(async () => noQuestions);
    const res = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });

    expect(res.body).not.toContain('tab-questions');
    expect(res.body).not.toContain('panel-questions');
    expect(res.body).toContain('"hasQuestions":false');
  });

  it('?mute=1 renders the muted screenshare variant; nothing else differs', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const unmuted = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });
    const muted = await app.inject({ method: 'GET', url: `/stage/${TOKEN}?mute=1` });

    expect(muted.statusCode).toBe(200);
    expect(muted.body).toContain('autoplay preload="auto" muted');
    expect(muted.body.replace(' muted', '')).toBe(unmuted.body);
  });

  it('escapes LLM-derived content — markup in devotional fields never reaches the DOM raw', async () => {
    const hostile: StageLookupResult = {
      ...OK_VIEW,
      page: {
        ...OK_VIEW.page,
        devotional: {
          ...OK_VIEW.page.devotional,
          theme: '<script>alert(1)</script>',
          devotionalBody: 'Grace & truth <img src=x onerror=alert(1)>',
        },
      },
      manifest: [
        { section: 'greeting', startSec: 0, endSec: 2, text: '</script><script>alert(1)</script>' },
      ],
    } as StageLookupResult;
    const app = buildTestApp(async () => hostile);
    const res = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('<img src=x');
    // The inlined JSON escapes `<` so `</script>` cannot close the block.
    expect(res.body).toContain('\\u003c/script');
  });

  it('renders without an audio element (content still shown) when audio is unavailable', async () => {
    const noAudio: StageLookupResult = {
      ...OK_VIEW,
      page: { ...OK_VIEW.page, audioUrl: null },
    } as StageLookupResult;
    const app = buildTestApp(async () => noAudio);
    const res = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('id="stage-audio"');
    expect(res.body).toContain('Come to me, all you who are weary');
  });

  it('returns 404 without ever calling getStageView for a non-UUID token (enumeration safety)', async () => {
    const getStageView = vi.fn();
    const app = buildTestApp(getStageView);
    const res = await app.inject({ method: 'GET', url: '/stage/not-a-uuid' });
    expect(res.statusCode).toBe(404);
    expect(getStageView).not.toHaveBeenCalled();
  });
});

describe('GET /stage/:token — enumeration-safe 404 parity (Q3 #333)', () => {
  it('unknown vs expired-not-yet-purged vs purged: byte-identical responses (status, content-type, body)', async () => {
    // The fake collapses all three server-side states to not_found —
    // exactly what sessionService.getStageView does (its own collapse is
    // pinned in stageView.test.ts). This test pins the ROUTE: any
    // not_found, plus the malformed-token short-circuit, must produce one
    // indistinguishable response.
    const app = buildTestApp(async () => ({ kind: 'not_found' }));

    const unknown = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });
    const expired = await app.inject({ method: 'GET', url: `/stage/${OTHER_TOKEN}` });
    const malformed = await app.inject({ method: 'GET', url: '/stage/never-a-token' });

    expect(unknown.statusCode).toBe(404);
    expect(expired.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.body).toBe(expired.body);
    expect(unknown.body).toBe(malformed.body);
    expect(unknown.headers['content-type']).toBe(expired.headers['content-type']);
    expect(unknown.headers['content-type']).toBe(malformed.headers['content-type']);
  });

  it('the gone page is a calm neutral card styled for the Stage surface (this can end up on camera)', async () => {
    const app = buildTestApp(async () => ({ kind: 'not_found' }));
    const res = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });

    expect(res.body).toContain("This link isn&#39;t active.");
    expect(res.body).toContain('Wellspring');
    expect(res.body).toContain('overflow: hidden'); // no scrollbars at 1280×720
    expect(res.body).not.toContain('stage.js'); // no script on the gone page
    expect(res.body).not.toContain('Error');
  });
});

describe('GET /stage/assets/stage.js', () => {
  it('serves the vanilla client script same-origin', async () => {
    const app = buildTestApp(async () => OK_VIEW);
    const res = await app.inject({ method: 'GET', url: '/stage/assets/stage.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('function captionAt(');
    expect(res.body).toContain('function tabAt(');
  });
});

describe('stage scope CSP + rate limiting (buildApp wiring)', () => {
  function buildFullApp() {
    const stageService = { getStageView: vi.fn().mockResolvedValue(OK_VIEW) };
    // The session scope needs a SessionService-shaped object; only
    // getSessionView is exercised by the session GET below.
    const sessionService = {
      getSessionView: vi.fn().mockResolvedValue({ kind: 'ok', page: OK_VIEW.page }),
      getStageView: stageService.getStageView,
      getCompletionView: vi.fn(),
      completeSession: vi.fn(),
      recordFeedback: vi.fn(),
    } as unknown as SessionService;
    return buildApp({
      sessionService,
      stageRoutes: { sessionService: stageService },
    });
  }

  it("/stage carries a JS-enabled CSP (script-src 'self') while /session keeps script-src 'none'", async () => {
    const app = buildFullApp();
    try {
      const stageRes = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });
      const sessionRes = await app.inject({ method: 'GET', url: `/session/${TOKEN}` });

      expect(stageRes.statusCode).toBe(200);
      expect(stageRes.headers['content-security-policy']).toContain("script-src 'self'");
      expect(stageRes.headers['content-security-policy']).toContain(
        'media-src \'self\' https://storage.googleapis.com',
      );
      expect(stageRes.headers['content-security-policy']).toContain("frame-ancestors 'none'");

      expect(sessionRes.statusCode).toBe(200);
      expect(sessionRes.headers['content-security-policy']).toContain("script-src 'none'");
    } finally {
      await app.close();
    }
  });

  it('rate limiting keys on token+IP like the session scope (429 after max, per token)', async () => {
    const stageService = { getStageView: vi.fn().mockResolvedValue(OK_VIEW) };
    const app = buildApp({
      stageRoutes: { sessionService: stageService },
      sessionRateLimit: { max: 3, timeWindowMs: 60_000 },
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const ok = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });
        expect(ok.statusCode).toBe(200);
      }
      const limited = await app.inject({ method: 'GET', url: `/stage/${TOKEN}` });
      expect(limited.statusCode).toBe(429);
      expect(JSON.parse(limited.body).error.code).toBe('RATE_LIMITED');

      // A DIFFERENT token from the same IP has its own budget — the
      // limiter keys on token+IP, not IP alone.
      const otherToken = await app.inject({ method: 'GET', url: `/stage/${OTHER_TOKEN}` });
      expect(otherToken.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
