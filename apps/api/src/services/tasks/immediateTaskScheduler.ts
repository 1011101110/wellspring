/**
 * ImmediateTaskScheduler — the Q6 (#336) demo dispatch path: a
 * `TaskScheduler` that, instead of enqueueing a Cloud Task to fire at
 * `scheduleTime`, POSTs the task's HTTP request immediately, fire-and-
 * forget. Activated by `MEETBOT_IMMEDIATE_DISPATCH=1` (index.ts) so that
 * "Generate now" puts a bot in the Meet within the demo take, with zero
 * new infra — no queue, no scheduler jobs, no new services.
 *
 * Why the swap happens HERE and not at the orchestrator call site: the
 * orchestrator already talks to a `taskScheduler.scheduleHttpTask`
 * interface (generateNowOrchestrator.ts ~1075) with a log-and-continue
 * posture around it. Implementing that same interface keeps the call site
 * — and its semantics, including the fire-time consent gate inside the
 * dispatch route — completely untouched: the flag swaps the transport,
 * not the behavior.
 *
 * Fire-and-forget is load-bearing (#296): `/internal/dispatch-meetbot`
 * supervises the bot's whole lifecycle (up to 20 minutes) before it
 * responds, and iOS generate-now already times out — generation latency
 * cannot grow at all. So `scheduleHttpTask` resolves as soon as the
 * request is *sent*, never awaiting the response (not even its headers —
 * they only arrive when the dispatch completes). Outcomes land in logs:
 * the dispatch route's own request logging on success, and this class's
 * error hook if the POST itself fails.
 *
 * Cloud Run caveat, considered: with request-scoped CPU, a fire-and-
 * forget fetch to another service can be throttled once the generate-now
 * response returns — but this fetch targets OUR OWN service's
 * `/internal/dispatch-meetbot`, which is itself a request and gets its
 * own CPU allocation. The send only needs the socket write to happen,
 * which occurs before the orchestrator finishes its remaining steps and
 * responds.
 *
 * `scheduleTime` is deliberately ignored — "immediate" is the entire
 * point. The one production wiring gates this class behind a startup
 * mutual-exclusion check against the Cloud Tasks config
 * (`assertMeetBotDispatchConfigExclusive` below) so both transports can
 * never be live at once.
 */
import type { ScheduleHttpTaskParams, TaskScheduler } from './taskScheduler.js';

export interface ImmediateTaskSchedulerDeps {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

const noopLogger = { info: () => {}, error: () => {} };

export class ImmediateTaskScheduler implements TaskScheduler {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: NonNullable<ImmediateTaskSchedulerDeps['logger']>;

  constructor(deps: ImmediateTaskSchedulerDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = deps.logger ?? noopLogger;
  }

  async scheduleHttpTask(params: ScheduleHttpTaskParams): Promise<{ taskName: string }> {
    const taskName = `immediate-${params.taskName ?? 'task'}`;

    // Never throw and never block: a failure to *send* the dispatch is
    // logged at error (the orchestrator's own catch would log it too, but
    // by the time a rejected fetch promise settles, scheduleHttpTask has
    // long since resolved — so the .catch here is the only place an async
    // send failure can land). Note the deliberate absence of `await` on
    // the fetch: see the file header.
    try {
      this.fetchImpl(params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...params.headers },
        body: JSON.stringify(params.body),
      }).then(
        (response) => {
          this.logger.info(
            { taskName, status: response.status },
            'immediate dispatch responded',
          );
        },
        (err: unknown) => {
          this.logger.error(
            { taskName, err: err instanceof Error ? err.message : String(err) },
            'immediate dispatch send failed',
          );
        },
      );
    } catch (err) {
      // A synchronous throw from fetchImpl (mutation-checked in tests) is
      // the same non-event as an async one: log, keep the generation.
      this.logger.error(
        { taskName, err: err instanceof Error ? err.message : String(err) },
        'immediate dispatch send failed synchronously',
      );
    }

    return { taskName };
  }
}

/**
 * Startup guard (#336 "Safety"): `MEETBOT_IMMEDIATE_DISPATCH=1` and the
 * Cloud Tasks dispatch config are mutually exclusive — both set is a
 * refusal to boot, not a silent preference. Two live transports would
 * mean two bots per devotional (the dispatch route is not idempotent —
 * see routes/internal.ts), and whichever one a reader believed was
 * active, the other would still be running. A crash at boot with a clear
 * message is the cheap version of that debugging session.
 */
export function assertMeetBotDispatchConfigExclusive(env: NodeJS.ProcessEnv): void {
  if (env.MEETBOT_IMMEDIATE_DISPATCH !== '1') return;
  const tasksVars = ['MEETBOT_TASKS_PROJECT_ID', 'MEETBOT_TASKS_LOCATION', 'MEETBOT_TASKS_QUEUE'].filter(
    (name) => env[name],
  );
  if (tasksVars.length > 0) {
    throw new Error(
      `MEETBOT_IMMEDIATE_DISPATCH=1 and Cloud Tasks meetbot dispatch config (${tasksVars.join(', ')}) are mutually exclusive — ` +
        'unset one. The immediate-dispatch flag (#336) is the demo path that bypasses the queue; ' +
        'running both would dispatch two bots per devotional.',
    );
  }
}
