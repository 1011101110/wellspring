/**
 * TaskScheduler — schedules an HTTP task for future dispatch via Cloud
 * Tasks (H1c, #131). This is the ONLY per-event, future-scheduled dispatch
 * mechanism in this codebase; every other background job (daily run,
 * examen, purge, reschedule-check) uses Cloud Scheduler cron → a batch
 * endpoint that loops over all eligible users in one request. A
 * devotional's `gap_start_at` is a specific per-user future timestamp
 * (not a shared cron time), so exact-time Cloud Tasks dispatch is the
 * right shape here — confirmed via research that no per-user Cloud Tasks
 * pattern already existed to reuse.
 *
 * ⚠️ Must-confirm (docs/00_FOUNDATION.md §11): no live Cloud Tasks queue
 * exists yet. Creating one is a production-affecting action requiring
 * explicit owner confirmation (issue #131) — this client is built and
 * unit-tested against a fake, but `GcpTaskScheduler` itself has not been
 * exercised against a real queue.
 */
import { CloudTasksClient } from '@google-cloud/tasks';

export interface ScheduleHttpTaskParams {
  url: string;
  /** When the task should fire. Cloud Tasks executes at-or-after this time, not exactly at it. */
  scheduleTime: Date;
  headers: Record<string, string>;
  /** JSON-serializable request body. */
  body: unknown;
  /**
   * Optional stable name for idempotent dedup — Cloud Tasks rejects a
   * second task with the same name within its dedup window (~1 hour
   * after completion, up to 9 days after creation). Omit for a task
   * Cloud Tasks names automatically.
   */
  taskName?: string;
}

export interface TaskScheduler {
  scheduleHttpTask(params: ScheduleHttpTaskParams): Promise<{ taskName: string }>;
}

export interface GcpTaskSchedulerConfig {
  projectId: string;
  location: string;
  queue: string;
}

export class GcpTaskScheduler implements TaskScheduler {
  private readonly config: GcpTaskSchedulerConfig;
  private client: CloudTasksClient | undefined;

  constructor(config: GcpTaskSchedulerConfig) {
    this.config = config;
  }

  private getClient(): CloudTasksClient {
    if (!this.client) this.client = new CloudTasksClient();
    return this.client;
  }

  async scheduleHttpTask(params: ScheduleHttpTaskParams): Promise<{ taskName: string }> {
    const client = this.getClient();
    const parent = client.queuePath(this.config.projectId, this.config.location, this.config.queue);

    const [response] = await client.createTask({
      parent,
      task: {
        name: params.taskName ? `${parent}/tasks/${params.taskName}` : undefined,
        httpRequest: {
          httpMethod: 'POST',
          url: params.url,
          headers: { 'Content-Type': 'application/json', ...params.headers },
          body: Buffer.from(JSON.stringify(params.body), 'utf8'),
        },
        scheduleTime: { seconds: Math.floor(params.scheduleTime.getTime() / 1000) },
      },
    });

    return { taskName: response.name ?? '' };
  }
}
