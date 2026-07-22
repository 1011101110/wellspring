import { describe, expect, it, vi } from 'vitest';
import { GcpTaskScheduler } from '../../../src/services/tasks/taskScheduler.js';

function fakeCloudTasksClient(createTaskImpl: (req: unknown) => Promise<unknown>) {
  return {
    queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
    createTask: vi.fn(createTaskImpl),
  };
}

describe('GcpTaskScheduler', () => {
  it('builds the correct queue path and task shape', async () => {
    const fakeClient = fakeCloudTasksClient(async (req) => [{ name: 'projects/p/locations/l/queues/q/tasks/generated-id' }, req]);
    const scheduler = new GcpTaskScheduler({ projectId: 'p', location: 'l', queue: 'q' });
    // @ts-expect-error injecting a fake client for the test
    scheduler.client = fakeClient;

    const scheduleTime = new Date('2026-07-10T14:00:00Z');
    const result = await scheduler.scheduleHttpTask({
      url: 'https://api.example.com/internal/dispatch-meetbot',
      scheduleTime,
      headers: { 'X-Internal-Token': 'secret' },
      body: { meetingUrl: 'https://meet.google.com/abc' },
    });

    expect(result.taskName).toBe('projects/p/locations/l/queues/q/tasks/generated-id');
    expect(fakeClient.queuePath).toHaveBeenCalledWith('p', 'l', 'q');

    const [createTaskArg] = fakeClient.createTask.mock.calls[0] as [{ parent: string; task: Record<string, unknown> }];
    expect(createTaskArg.parent).toBe('projects/p/locations/l/queues/q');
    const httpRequest = createTaskArg.task['httpRequest'] as { url: string; httpMethod: string; headers: Record<string, string>; body: Buffer };
    expect(httpRequest.url).toBe('https://api.example.com/internal/dispatch-meetbot');
    expect(httpRequest.httpMethod).toBe('POST');
    expect(httpRequest.headers['X-Internal-Token']).toBe('secret');
    expect(httpRequest.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(httpRequest.body.toString('utf8'))).toEqual({ meetingUrl: 'https://meet.google.com/abc' });
    expect(createTaskArg.task['scheduleTime']).toEqual({ seconds: Math.floor(scheduleTime.getTime() / 1000) });
  });

  it('includes a named task when taskName is provided (for idempotent dedup)', async () => {
    const fakeClient = fakeCloudTasksClient(async (req) => [{ name: 'ignored' }, req]);
    const scheduler = new GcpTaskScheduler({ projectId: 'p', location: 'l', queue: 'q' });
    // @ts-expect-error injecting a fake client for the test
    scheduler.client = fakeClient;

    await scheduler.scheduleHttpTask({
      url: 'https://api.example.com/x',
      scheduleTime: new Date(),
      headers: {},
      body: {},
      taskName: 'devotional-abc123',
    });

    const [createTaskArg] = fakeClient.createTask.mock.calls[0] as [{ task: Record<string, unknown> }];
    expect(createTaskArg.task['name']).toBe('projects/p/locations/l/queues/q/tasks/devotional-abc123');
  });

  it('omits a task name when not provided (Cloud Tasks auto-names it)', async () => {
    const fakeClient = fakeCloudTasksClient(async (req) => [{ name: 'auto' }, req]);
    const scheduler = new GcpTaskScheduler({ projectId: 'p', location: 'l', queue: 'q' });
    // @ts-expect-error injecting a fake client for the test
    scheduler.client = fakeClient;

    await scheduler.scheduleHttpTask({ url: 'https://api.example.com/x', scheduleTime: new Date(), headers: {}, body: {} });

    const [createTaskArg] = fakeClient.createTask.mock.calls[0] as [{ task: Record<string, unknown> }];
    expect(createTaskArg.task['name']).toBeUndefined();
  });
});
