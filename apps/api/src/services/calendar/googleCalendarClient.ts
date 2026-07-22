/**
 * Thin fetch-based client for the Google Calendar REST API.
 *
 * Uses the user's OAuth2 refresh token (decrypted by GoogleKmsService) via
 * google-auth-library's OAuth2Client to mint short-lived access tokens.
 * googleapis npm package is NOT installed — plain fetch is used throughout.
 *
 * Privacy invariants (Foundation §8, non-negotiable):
 *  - freeBusy: returns ONLY busy time-windows (start/end strings), never
 *    event titles, attendees, locations, or notes. The Calendar API itself
 *    guarantees this for freebusy.query.
 *  - insertEvent: we INSERT our own events; we never read other events.
 *  - Busy blocks are NEVER written to the database — callers process them
 *    in memory only, then discard.
 *  - getCalendarTimeZone: reads the calendar's IANA zone WITHOUT reading any
 *    event content — see that method's doc for how the empty-window trick
 *    keeps the §8 invariant intact.
 */

import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** 60-second guard: re-mint a token if it expires within this many ms. */
const TOKEN_EXPIRY_GUARD_MS = 60_000;

export interface GoogleCalendarClientDeps {
  /** Returns the user's decrypted refresh token — called lazily, once per access-token cache miss. */
  getRefreshToken: () => Promise<string>;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface FreeBusyBlock {
  start: string;
  end: string;
}

export interface InsertEventParams {
  summary: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  /** When provided, adds an attendees entry so the event shows up on the user's calendar with RSVP. */
  attendeeEmail?: string;
  /**
   * H1 (#53), docs/22_EPIC_H_PLAN.md §3: requests a real Google Meet link
   * via `conferenceData.createRequest` (docs/03 §4.4's reserved
   * mechanism). Default false/omitted — every event today (and every
   * event that never opts into the H1 Meet-bot delivery path) is
   * unaffected; the session URL alone still rides in `description`.
   */
  requestConferenceData?: boolean;
}

export interface InsertEventResult {
  eventId: string;
  htmlLink: string;
  /**
   * The real Meet join URL, present only when `requestConferenceData`
   * was set AND Google's response included a video entry point. `null`
   * otherwise — never fabricated, never derived from anything but the
   * API's own response.
   */
  meetUri: string | null;
}

export class GoogleCalendarClient {
  private readonly getRefreshToken: () => Promise<string>;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  /** Cached access token + approximate expiry (ms since epoch). */
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(deps: GoogleCalendarClientDeps) {
    this.getRefreshToken = deps.getRefreshToken;
    this.clientId = deps.clientId;
    this.clientSecret = deps.clientSecret;
    this.redirectUri = deps.redirectUri;
  }

  /**
   * Returns a valid access token, re-minting from the refresh token when
   * the cached one is absent or within TOKEN_EXPIRY_GUARD_MS of expiry.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > TOKEN_EXPIRY_GUARD_MS) {
      return this.cachedToken.token;
    }

    const oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
    oauth2Client.setCredentials({ refresh_token: await this.getRefreshToken() });

    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse.token) {
      throw new Error('GoogleCalendarClient: OAuth2Client returned no access token');
    }

    // getAccessToken() refreshes credentials on the client; the updated
    // expiry_date is on oauth2Client.credentials after the call.
    const expiryDate =
      typeof oauth2Client.credentials.expiry_date === 'number'
        ? oauth2Client.credentials.expiry_date
        : now + 3_600_000; // fallback: 1 hour from now

    this.cachedToken = { token: tokenResponse.token, expiresAtMs: expiryDate };
    return tokenResponse.token;
  }

  /**
   * Queries free/busy blocks for the user's primary calendar.
   *
   * PRIVACY (Foundation §8): freebusy.query returns ONLY start/end times for
   * busy windows — no event titles, attendees, locations, or notes are
   * present in the response. This is the purpose of this specific API scope.
   */
  async getFreeBusyBlocks(params: {
    timeMin: string;
    timeMax: string;
    timeZone: string;
  }): Promise<FreeBusyBlock[]> {
    const token = await this.getAccessToken();

    const response = await fetch(`${CALENDAR_BASE}/freeBusy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        timeZone: params.timeZone,
        items: [{ id: 'primary' }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Calendar freeBusy failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as {
      calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } };
    };

    // Return only start/end — never the event content (which doesn't exist
    // in this response anyway, by API design).
    return (data.calendars?.primary?.busy ?? []).map((b) => ({ start: b.start, end: b.end }));
  }

  /**
   * Reads the IANA time zone of the user's primary calendar (e.g.
   * "America/New_York") — the zone Google itself schedules them in, which
   * is the best available answer to "when is *their* morning?".
   *
   * Why this exists: `users.timezone` defaults to UTC and nothing ever
   * populated it, so gap-finding anchored a user's 07:00–09:00 local window
   * to UTC. For anyone not actually in UTC that picks the wrong time of day
   * entirely (Eastern users got a 3:30am "morning" devotional).
   *
   * PRIVACY (Foundation §8) — why this does not read event content:
   * The obvious APIs for this (`calendars.get`, `settings.get`) require
   * `calendar.readonly` or broader, i.e. asking the user for permission to
   * read every event on every calendar in order to learn one string. That
   * trade is not worth making.
   *
   * Instead we use `events.list`, which IS covered by the `calendar.events`
   * scope the user already granted, and whose response carries the
   * calendar's `timeZone` at the top level. To guarantee no event content
   * is ever returned, the query window is pinned to a far-future instant
   * where no events can exist, and `maxResults` is 1. The response is
   * therefore `{ ..., timeZone, items: [] }` — the zone, and nothing else.
   * We read `timeZone` and ignore the rest of the body.
   *
   * Returns `undefined` rather than throwing: a missing time zone must
   * never fail a connect or a generation. Callers fall back to the stored
   * value (UTC by default).
   */
  async getCalendarTimeZone(): Promise<string | undefined> {
    const token = await this.getAccessToken();

    // A window far enough out that no real event can fall inside it, so
    // `items` is guaranteed empty while `timeZone` is still returned.
    const timeMin = '2999-01-01T00:00:00Z';
    const timeMax = '2999-01-02T00:00:00Z';
    const url =
      `${CALENDAR_BASE}/calendars/primary/events` +
      `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=1`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return undefined;

    const data = (await response.json()) as { timeZone?: string; items?: unknown[] };
    // Defensive: if Google ever returned items here, do not touch them.
    return typeof data.timeZone === 'string' && data.timeZone.length > 0
      ? data.timeZone
      : undefined;
  }

  /**
   * Inserts a Wellspring event on the user's primary calendar (docs/03 §4.2).
   * We are writing OUR OWN event — we never read or return any other event data.
   */
  async insertEvent(params: InsertEventParams): Promise<InsertEventResult> {
    const token = await this.getAccessToken();

    const body: Record<string, unknown> = {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.startDateTime, timeZone: params.timeZone },
      end: { dateTime: params.endDateTime, timeZone: params.timeZone },
      extendedProperties: { private: { kairos: 'true' } },
      reminders: { useDefault: true },
    };

    if (params.attendeeEmail) {
      body['attendees'] = [{ email: params.attendeeEmail }];
    }

    // H1 (#53): conferenceDataVersion=1 query param is required alongside
    // conferenceData.createRequest, per docs/03 §4.4's reserved mechanism —
    // omitted entirely (both the param and the request body field) unless
    // explicitly requested, so every existing caller is byte-identical.
    let url = `${CALENDAR_BASE}/calendars/primary/events`;
    if (params.requestConferenceData) {
      url += '?conferenceDataVersion=1';
      body['conferenceData'] = {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Calendar insertEvent failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as {
      id?: string;
      htmlLink?: string;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
    };
    if (!data.id) throw new Error('Calendar insertEvent: response missing event id');

    const videoEntryPoint = data.conferenceData?.entryPoints?.find(
      (entryPoint) => entryPoint.entryPointType === 'video',
    );

    return {
      eventId: data.id,
      htmlLink: data.htmlLink ?? '',
      meetUri: videoEntryPoint?.uri ?? null,
    };
  }

  /** Deletes a Wellspring-owned calendar event by its provider event ID. */
  async deleteEvent(eventId: string): Promise<void> {
    const token = await this.getAccessToken();

    const response = await fetch(`${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    // 204 No Content = success; 404 = already gone (treat as success).
    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Calendar deleteEvent failed: HTTP ${response.status} — ${text}`);
    }
  }

  /**
   * Returns a new GoogleCalendarClient that uses the given refresh token
   * directly instead of calling `getRefreshToken` lazily. Used by
   * GenerateNowOrchestrator to build a per-request client from the
   * already-decrypted token for a specific user (avoiding any shared
   * token-cache state between users).
   */
  withRefreshToken(refreshToken: string): GoogleCalendarClient {
    return new GoogleCalendarClient({
      getRefreshToken: () => Promise.resolve(refreshToken),
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
    });
  }

  /**
   * Partially updates a Wellspring-owned calendar event (reschedule / description update).
   * Only fields present in `patch` are sent — all others are left unchanged.
   */
  async patchEvent(
    eventId: string,
    patch: {
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
      description?: string;
    },
  ): Promise<void> {
    const token = await this.getAccessToken();

    const body: Record<string, unknown> = {};
    if (patch.description !== undefined) body['description'] = patch.description;
    if (patch.startDateTime !== undefined) {
      body['start'] = { dateTime: patch.startDateTime, timeZone: patch.timeZone };
    }
    if (patch.endDateTime !== undefined) {
      body['end'] = { dateTime: patch.endDateTime, timeZone: patch.timeZone };
    }

    const response = await fetch(
      `${CALENDAR_BASE}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`Calendar patchEvent failed: HTTP ${response.status} — ${text}`);
    }
  }
}
