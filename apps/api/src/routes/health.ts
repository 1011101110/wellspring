import type { FastifyInstance } from 'fastify';

/**
 * The commit this container was built from, injected at deploy time
 * (`BUILD_SHA`). `unknown` locally and in tests, where there is no build.
 *
 * Read once at module load rather than per-request: it cannot change for
 * the life of a process, and a per-request `process.env` read would invite
 * someone to think it could.
 */
const BUILD_SHA = process.env.BUILD_SHA ?? 'unknown';

/**
 * GET /status — unauthenticated (Foundation §10: API endpoints require
 * auth "except /status and the session-join page"). Used by the Cloud Run
 * deploy workflow's post-deploy health check and local dev verification.
 *
 * Why this reports `buildSha` (issue #230):
 *
 * On 2026-07-18 staging served stale code for roughly two and a half hours
 * while every signal reported green. A migration collision failed six
 * deploys; one failure fired the workflow's rollback step, which runs
 * `update-traffic --to-revisions <prev>=100`. That *pins* traffic and
 * disables Cloud Run's default "latest revision serves", so every later
 * deploy built a healthy revision that received zero traffic.
 *
 * The post-deploy health check curled this endpoint and got a 200 every
 * time — from the pinned old revision. A 200 proves *something* is alive.
 * It cannot prove that the thing you just built is the thing serving, and
 * that is precisely the question a post-deploy check exists to answer.
 *
 * With the SHA here, the workflow asserts `buildSha === github.sha` and a
 * silent no-op deploy becomes a red pipeline instead of a green one.
 *
 * Deliberately safe to expose unauthenticated: a commit SHA on a private
 * repo identifies a build, grants nothing, and is already implicit in any
 * response the service gives. That is a smaller cost than the failure mode
 * it retires.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/status', async () => {
    return { status: 'ok', buildSha: BUILD_SHA, timestamp: new Date().toISOString() };
  });
}
