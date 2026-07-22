/**
 * Unit tests for ResendEmailSender (issue #74, docs/03 §5). Uses a fake
 * `fetch` — RESEND_API_KEY does not exist yet, so this is NOT live-tested;
 * it verifies the class is built correctly against Resend's documented
 * API shape (https://resend.com/docs/api-reference/emails/send-email).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ResendEmailSender,
  ResendEmailSenderError,
  buildEmailSenderFromEnv,
  type ResendFetchLike,
} from '../../../src/services/invite/resendEmailSender.js';
import { ConsoleEmailSender, type IcsEmailMessage } from '../../../src/services/invite/icsInvite.js';

const SAMPLE_MESSAGE: IcsEmailMessage = {
  to: [{ email: 'jane@example.com', name: 'Jane' }],
  from: { email: 'invites@kairos.app', name: 'Wellspring' },
  subject: 'Wellspring — a moment of rest',
  bodyText: 'Your Wellspring moment is booked.',
  ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
  method: 'REQUEST',
};

function fakeFetch(response: { ok: boolean; status: number; body?: unknown }): ResendFetchLike {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body ?? {},
    text: async () => JSON.stringify(response.body ?? {}),
  }) as unknown as ResendFetchLike;
}

describe('ResendEmailSender', () => {
  it('POSTs to the documented Resend endpoint with Bearer auth and a base64 .ics attachment', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { id: 'email_123' } });
    const sender = new ResendEmailSender({ apiKey: 'test-key', fetchImpl });

    await sender.send(SAMPLE_MESSAGE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.from).toBe('Wellspring <invites@kairos.app>');
    expect(body.to).toEqual(['Jane <jane@example.com>']);
    expect(body.subject).toBe('Wellspring — a moment of rest');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].content_type).toBe('text/calendar; method=REQUEST');
    expect(Buffer.from(body.attachments[0].content, 'base64').toString('utf-8')).toBe(SAMPLE_MESSAGE.ics);
  });

  it('addresses all recipients on one email for a team invite (I3)', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    const sender = new ResendEmailSender({ apiKey: 'test-key', fetchImpl });

    await sender.send({
      ...SAMPLE_MESSAGE,
      to: [
        { email: 'jane@example.com', name: 'Jane' },
        { email: 'sam@example.com', name: 'Sam' },
        { email: 'noname@example.com' },
      ],
    });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['Jane <jane@example.com>', 'Sam <sam@example.com>', 'noname@example.com']);
  });

  it('uses method=CANCEL content-type for a cancellation message', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    const sender = new ResendEmailSender({ apiKey: 'test-key', fetchImpl });

    await sender.send({ ...SAMPLE_MESSAGE, method: 'CANCEL', subject: 'Cancelled: Wellspring' });

    const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.attachments[0].content_type).toBe('text/calendar; method=CANCEL');
    expect(body.attachments[0].filename).toBe('cancel.ics');
  });

  it('throws ResendEmailSenderError with response detail on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 422, body: { message: 'invalid from address' } });
    const sender = new ResendEmailSender({ apiKey: 'test-key', fetchImpl });

    await expect(sender.send(SAMPLE_MESSAGE)).rejects.toThrow(ResendEmailSenderError);
    await expect(sender.send(SAMPLE_MESSAGE)).rejects.toThrow(/422/);
  });

  it('throws ResendEmailSenderError on a network/transport failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as ResendFetchLike;
    const sender = new ResendEmailSender({ apiKey: 'test-key', fetchImpl });

    await expect(sender.send(SAMPLE_MESSAGE)).rejects.toThrow(ResendEmailSenderError);
  });

  it('rejects construction with an empty apiKey', () => {
    expect(() => new ResendEmailSender({ apiKey: '' })).toThrow();
  });
});

describe('buildEmailSenderFromEnv', () => {
  it('selects ResendEmailSender when RESEND_API_KEY is set', () => {
    const { sender, description } = buildEmailSenderFromEnv({ RESEND_API_KEY: 'live-key' } as NodeJS.ProcessEnv);
    expect(sender).toBeInstanceOf(ResendEmailSender);
    expect(description).toContain('ResendEmailSender');
  });

  it('defaults to ConsoleEmailSender when RESEND_API_KEY is not configured (current credential reality)', () => {
    const { sender, description } = buildEmailSenderFromEnv({} as NodeJS.ProcessEnv);
    expect(sender).toBeInstanceOf(ConsoleEmailSender);
    expect(description).toContain('ConsoleEmailSender');
  });
});
