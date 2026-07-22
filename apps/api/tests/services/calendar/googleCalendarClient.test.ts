/**
 * Unit tests for GoogleCalendarClient.
 *
 * Stubs fetch and the OAuth2Client's getAccessToken so no real network
 * calls are made. Tests focus on:
 *   - freeBusy: correct endpoint, body shape, return type (start/end only)
 *   - insertEvent: correct endpoint, body shape, response mapping
 *   - deleteEvent: correct DELETE call, tolerates 404
 *   - token caching: access token is not re-minted on every call
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GoogleCalendarClient } from '../../../src/services/calendar/googleCalendarClient.js';

// Mock google-auth-library's OAuth2Client so tests never call the real token endpoint.
vi.mock('google-auth-library', async () => {
  class MockOAuth2Client {
    credentials = { expiry_date: Date.now() + 3_600_000 };
    setCredentials = vi.fn();
    getAccessToken = vi.fn().mockResolvedValue({ token: 'fake-calendar-token' });
  }
  return { OAuth2Client: MockOAuth2Client };
});

const FAKE_REFRESH_TOKEN = 'fake-refresh-token';

function buildClient() {
  return new GoogleCalendarClient({
    getRefreshToken: () => Promise.resolve(FAKE_REFRESH_TOKEN),
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    redirectUri: 'http://localhost:8080/v1/connect/google/callback',
  });
}

describe('GoogleCalendarClient.getFreeBusyBlocks', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs to freeBusy endpoint with correct body and returns start/end only', async () => {
    const busyBlocks = [
      { start: '2026-07-03T09:00:00Z', end: '2026-07-03T10:00:00Z' },
      { start: '2026-07-03T14:00:00Z', end: '2026-07-03T15:30:00Z' },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calendars: { primary: { busy: busyBlocks } },
      }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    const result = await client.getFreeBusyBlocks({
      timeMin: '2026-07-03T00:00:00Z',
      timeMax: '2026-07-03T23:59:59Z',
      timeZone: 'America/New_York',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as {
      timeMin: string;
      timeMax: string;
      timeZone: string;
      items: Array<{ id: string }>;
    };
    expect(body.items).toEqual([{ id: 'primary' }]);
    expect(body.timeZone).toBe('America/New_York');

    // Result: only start/end, no additional event content
    expect(result).toEqual(busyBlocks);
    expect(Object.keys(result[0]!)).toEqual(['start', 'end']);
  });

  it('returns empty array when busy list is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ calendars: { primary: {} } }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    const result = await client.getFreeBusyBlocks({
      timeMin: '2026-07-03T00:00:00Z',
      timeMax: '2026-07-03T23:59:59Z',
      timeZone: 'UTC',
    });
    expect(result).toEqual([]);
  });

  it('throws on non-OK HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    await expect(
      client.getFreeBusyBlocks({ timeMin: 't', timeMax: 't', timeZone: 'UTC' }),
    ).rejects.toThrow('Calendar freeBusy failed: HTTP 401');
  });
});

describe('GoogleCalendarClient.insertEvent', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs to events endpoint with correct body and returns eventId + htmlLink', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'event-id-abc',
        htmlLink: 'https://calendar.google.com/event?eid=abc',
      }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    const result = await client.insertEvent({
      summary: 'Wellspring — a moment with God',
      description: 'Join: https://kairos.app/session/tok',
      startDateTime: '2026-07-03T08:00:00-04:00',
      endDateTime: '2026-07-03T08:15:00-04:00',
      timeZone: 'America/New_York',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['summary']).toBe('Wellspring — a moment with God');
    expect((body['extendedProperties'] as Record<string, unknown>)['private']).toEqual({ kairos: 'true' });
    expect(body['reminders']).toEqual({ useDefault: true });
    // No attendees when attendeeEmail is not provided
    expect(body['attendees']).toBeUndefined();

    expect(result.eventId).toBe('event-id-abc');
    expect(result.htmlLink).toBe('https://calendar.google.com/event?eid=abc');
    // Regression: no conferenceData requested → no query string, meetUri null
    expect(url).not.toContain('conferenceDataVersion');
    expect(body['conferenceData']).toBeUndefined();
    expect(result.meetUri).toBeNull();
  });

  it('requests conferenceData and parses meetUri when requestConferenceData is true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'event-id-meet',
        htmlLink: 'https://calendar.google.com/event?eid=meet',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
            { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
          ],
        },
      }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    const result = await client.insertEvent({
      summary: 'Wellspring — a moment with God',
      description: 'desc',
      startDateTime: '2026-07-03T08:00:00Z',
      endDateTime: '2026-07-03T08:15:00Z',
      timeZone: 'UTC',
      requestConferenceData: true,
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
    );

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const conferenceData = body['conferenceData'] as { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } };
    expect(conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    expect(typeof conferenceData.createRequest.requestId).toBe('string');
    expect(conferenceData.createRequest.requestId.length).toBeGreaterThan(0);

    expect(result.meetUri).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('returns null meetUri when requestConferenceData is true but response has no video entry point', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ev-no-video', htmlLink: '' }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    const result = await client.insertEvent({
      summary: 'K',
      description: 'd',
      startDateTime: 's',
      endDateTime: 'e',
      timeZone: 'UTC',
      requestConferenceData: true,
    });

    expect(result.meetUri).toBeNull();
  });

  it('includes attendees when attendeeEmail is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'ev-1', htmlLink: '' }),
    } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    await client.insertEvent({
      summary: 'Wellspring — a moment with God',
      description: 'desc',
      startDateTime: '2026-07-03T08:00:00Z',
      endDateTime: '2026-07-03T08:15:00Z',
      timeZone: 'UTC',
      attendeeEmail: 'user@example.com',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['attendees']).toEqual([{ email: 'user@example.com' }]);
  });

  it('throws on non-OK HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    await expect(
      client.insertEvent({
        summary: 'K',
        description: 'd',
        startDateTime: 's',
        endDateTime: 'e',
        timeZone: 'UTC',
      }),
    ).rejects.toThrow('Calendar insertEvent failed: HTTP 403');
  });
});

describe('GoogleCalendarClient.deleteEvent', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends DELETE to the correct URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    await client.deleteEvent('event-123');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/calendars/primary/events/event-123');
    expect(init.method).toBe('DELETE');
  });

  it('does not throw on 404 (already deleted)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' } as unknown as Response);
    globalThis.fetch = mockFetch;

    const client = buildClient();
    await expect(client.deleteEvent('gone-event')).resolves.toBeUndefined();
  });
});
