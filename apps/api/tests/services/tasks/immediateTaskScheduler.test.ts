/**
 * Unit tests for the Q6 (#336) demo dispatch path: ImmediateTaskScheduler
 * (fire-and-forget POST in place of a Cloud Task) and the startup
 * mutual-exclusion guard against the Cloud Tasks config.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ImmediateTaskScheduler,
  assertMeetBotDispatchConfigExclusive,
} from '../../../src/services/tasks/immediateTaskScheduler.js';
import type { ScheduleHttpTaskParams } from '../../../src/services/tasks/taskScheduler.js';

const PARAMS: ScheduleHttpTaskParams = {
  url: 'http://localhost:8080/internal/dispatch-meetbot',
  scheduleTime: new Date('2026-07-23T12:00:00Z'),
  headers: { 'X-Internal-Token': 'secret-token' },
  body: { meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' },
  taskName: 'meetbot-devo-1',
};

describe('ImmediateTaskScheduler', () => {
  it('fires one POST to the dispatch URL with the internal token header and JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    const scheduler = new ImmediateTaskScheduler({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await scheduler.scheduleHttpTask(PARAMS);

    expect(result).toEqual({ taskName: 'immediate-meetbot-devo-1' });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('http://localhost:8080/internal/dispatch-meetbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'secret-token' },
      body: JSON.stringify({ meetingUrl: 'https://meet.google.com/abc-defg-hij', devotionalId: 'devo-1' }),
    });
  });

  it('resolves WITHOUT awaiting the dispatch response (#296: the route holds its response for the bot lifecycle, up to 20 min)', async () => {
    // A fetch whose promise never settles models the real dispatch route,
    // which only responds after runMeetBotDispatch completes. If
    // scheduleHttpTask awaited anything about the response, this test
    // would hang and time out — its completion IS the assertion.
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
    const scheduler = new ImmediateTaskScheduler({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await scheduler.scheduleHttpTask(PARAMS);

    expect(result.taskName).toBe('immediate-meetbot-devo-1');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('logs and resolves when the send fails asynchronously (network error to self)', async () => {
    const error = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const scheduler = new ImmediateTaskScheduler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info: vi.fn(), error },
    });

    await expect(scheduler.scheduleHttpTask(PARAMS)).resolves.toEqual({
      taskName: 'immediate-meetbot-devo-1',
    });
    // Let the rejected fetch promise settle so the .catch hook runs.
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      'immediate dispatch send failed',
    );
  });

  it('logs and resolves when fetch throws SYNCHRONOUSLY (#336 mutation check on log-and-continue)', async () => {
    const error = vi.fn();
    const fetchImpl = vi.fn(() => {
      throw new Error('sync boom');
    });
    const scheduler = new ImmediateTaskScheduler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info: vi.fn(), error },
    });

    await expect(scheduler.scheduleHttpTask(PARAMS)).resolves.toEqual({
      taskName: 'immediate-meetbot-devo-1',
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'sync boom' }),
      'immediate dispatch send failed synchronously',
    );
  });

  it('logs the response status once the dispatch eventually responds', async () => {
    const info = vi.fn();
    let resolveFetch!: (value: { status: number }) => void;
    const fetchImpl = vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const scheduler = new ImmediateTaskScheduler({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { info, error: vi.fn() },
    });

    await scheduler.scheduleHttpTask(PARAMS);
    expect(info).not.toHaveBeenCalled(); // nothing to log until the route answers

    resolveFetch({ status: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'immediate-meetbot-devo-1', status: 200 }),
      'immediate dispatch responded',
    );
  });
});

describe('assertMeetBotDispatchConfigExclusive (#336 startup guard)', () => {
  it('boots quietly when the flag is off, whatever the Cloud Tasks config says', () => {
    expect(() => assertMeetBotDispatchConfigExclusive({})).not.toThrow();
    expect(() =>
      assertMeetBotDispatchConfigExclusive({
        MEETBOT_TASKS_PROJECT_ID: 'p',
        MEETBOT_TASKS_LOCATION: 'l',
        MEETBOT_TASKS_QUEUE: 'q',
      }),
    ).not.toThrow();
  });

  it('boots quietly with the flag on and no Cloud Tasks config', () => {
    expect(() =>
      assertMeetBotDispatchConfigExclusive({ MEETBOT_IMMEDIATE_DISPATCH: '1' }),
    ).not.toThrow();
  });

  it('refuses to start when the flag AND the Cloud Tasks config are both set, naming the offending vars', () => {
    expect(() =>
      assertMeetBotDispatchConfigExclusive({
        MEETBOT_IMMEDIATE_DISPATCH: '1',
        MEETBOT_TASKS_PROJECT_ID: 'p',
        MEETBOT_TASKS_LOCATION: 'l',
        MEETBOT_TASKS_QUEUE: 'q',
      }),
    ).toThrow(/mutually exclusive.*MEETBOT_TASKS_PROJECT_ID|MEETBOT_TASKS_PROJECT_ID.*mutually exclusive/s);
  });

  it('refuses even a PARTIAL Cloud Tasks config alongside the flag (a half-configured queue is still a config conflict)', () => {
    expect(() =>
      assertMeetBotDispatchConfigExclusive({
        MEETBOT_IMMEDIATE_DISPATCH: '1',
        MEETBOT_TASKS_QUEUE: 'q',
      }),
    ).toThrow(/MEETBOT_TASKS_QUEUE/);
  });

  it('treats only the literal "1" as the flag being on (documented boolean-ish style)', () => {
    expect(() =>
      assertMeetBotDispatchConfigExclusive({
        MEETBOT_IMMEDIATE_DISPATCH: 'true',
        MEETBOT_TASKS_PROJECT_ID: 'p',
      }),
    ).not.toThrow();
  });
});
