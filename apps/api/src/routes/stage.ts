/**
 * GET /stage/:token and GET /stage/assets/stage.js — the Stage page
 * surface (Q2 #332 / Q3 #333, epic #330): the visual devotional Attendee's
 * browser-voice-agent loads into a Google Meet, and the standalone demo
 * floor. Public, same capability-token model as /session/:token (the
 * UUIDv4 token IS the credential — Foundation §10).
 *
 * READ-ONLY session lookup: uses `getStageView`, never `getSessionView` —
 * the latter marks `joined_at` on open, and a bot container load counted
 * as a join would corrupt Epic P's attendance signals (#332). The deps
 * type below only ADMITS `getStageView`, so this route structurally
 * cannot make the writing call.
 *
 * Enumeration safety (Q3 #333, docs/04 §5.4): malformed, unknown,
 * expired-not-yet-purged, and purged tokens all produce byte-identical
 * 404 responses (the Stage-styled gone page) — `getStageView` collapses
 * expired/purged/unknown, and the malformed-token short-circuit sends the
 * exact same body. Rate limiting (token+IP) and the JS-enabled CSP come
 * from the stage scope in app.ts.
 */
import type { FastifyInstance } from 'fastify';
import { UuidParamSchema } from '@kairos/shared-contracts';
import type { StageLookupResult } from '../services/session/sessionService.js';
import { renderStageGonePage, renderStagePage } from '../services/stage/renderStagePage.js';
import { buildStageClientJs } from '../services/stage/stageClient.js';

export interface StageRoutesDeps {
  /** Only the READ-ONLY `getStageView` — a minimal shape (not the full `SessionService`) keeps the route independently testable AND makes the no-write rule structural. */
  sessionService: { getStageView(token: string): Promise<StageLookupResult> };
}

export function registerStageRoutes(app: FastifyInstance, deps: StageRoutesDeps): void {
  const { sessionService } = deps;

  // Built once at registration: the embedded timeline functions and
  // wiring are static per process (no per-request work).
  const stageJs = buildStageClientJs();

  app.get('/stage/assets/stage.js', async (_request, reply) => {
    return reply.status(200).type('application/javascript; charset=utf-8').send(stageJs);
  });

  app.get<{ Params: { token: string }; Querystring: { mute?: string } }>(
    '/stage/:token',
    async (request, reply) => {
      const { token } = request.params;
      if (!UuidParamSchema.safeParse(token).success) {
        return reply.status(404).type('text/html; charset=utf-8').send(renderStageGonePage());
      }

      const result = await sessionService.getStageView(token);
      if (result.kind === 'not_found') {
        return reply.status(404).type('text/html; charset=utf-8').send(renderStageGonePage());
      }

      // `?mute=1` — renders the audio element muted, timeline still runs.
      // Q4's live spike found Attendee rejects `url` + `screenshare_url`
      // together (HTTP 400), so there is never a dual page instance and
      // dispatch (Q5) will not use this; it stays as a zero-cost manual/
      // testing convenience (e.g. watching the page silently alongside a
      // call). No other behavior differs.
      const muted = request.query.mute === '1';

      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send(renderStagePage({ page: result.page, manifest: result.manifest, muted }));
    },
  );
}
