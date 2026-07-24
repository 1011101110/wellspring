// @vitest-environment jsdom
/**
 * Staged-save regression tests for the app shell (#344).
 *
 * ## The two bugs these pin against
 *
 * `App.tsx` states its own principle: the PreferencesForm is a *staged*
 * edit surface (nothing persists until "Save changes"), while the
 * calendar reading toggle (#299) and the rhythm card (#327) persist
 * immediately. The seam between the two is where both bugs lived:
 *
 *  1. The calendar toggle routed through `save()`, which re-sent the
 *     WHOLE staged form — flipping a consent switch silently committed
 *     every unsaved form edit.
 *  2. `saveRhythm` adopted the full PUT response into the form
 *     (`setPrefs(fromServer(data))`) — the response echoes the *stored*
 *     form values, so clicking a rhythm control silently reverted every
 *     unsaved form edit.
 *
 * Each test stages an edit, drives one immediate-persist control, and
 * asserts the edit was **neither committed** (the PUT body carries
 * exactly the one control's field) **nor lost** (the form still shows
 * the staged value after the response is applied). These are component
 * tests through the real `<App />` on purpose: the defect was in the
 * shell's wiring, not in any pure function a lib test could see.
 *
 * ## Rig
 *
 * jsdom + Testing Library, opted into per-file (the rest of this suite
 * is pure functions and stays on the node environment). Everything
 * behind the `apiFetch` seam is real — `getPreferences`/`putPreferences`
 * parse with the genuine shared contract — and everything beyond it is
 * canned: unknown endpoints reject, which the dashboard's per-card
 * loaders are built to absorb (#237).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PreferencesResponseData, Rhythm } from '@kairos/shared-contracts';

vi.mock('../src/firebase', () => ({
  auth: {},
  signOutOfKairos: vi.fn(),
  signInWithGoogle: vi.fn(),
  describeAuthError: () => 'auth error',
}));

vi.mock('firebase/auth', () => ({
  // Resolve auth synchronously with a signed-in user so the shell goes
  // straight to `load()`.
  onAuthStateChanged: (_auth: unknown, next: (user: unknown) => void) => {
    next({ email: 'pilgrim@example.com' });
    return () => {};
  },
}));

vi.mock('../src/api/client', () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError, apiFetch: vi.fn() };
});

import { apiFetch } from '../src/api/client';
import { App } from '../src/App';

const apiFetchMock = vi.mocked(apiFetch);

function baseRhythm(): Rhythm {
  return { mode: 'adaptive', daysPerWeek: 3, minPerWeek: 2, reason: 'hold' };
}

/** A full, contract-valid `/v1/preferences` row for an onboarded user. */
function baseRow(): PreferencesResponseData {
  return {
    userId: 'u-1',
    windowStartLocal: '09:00:00',
    windowEndLocal: '17:00:00',
    activeDays: [1, 2, 3, 4, 5],
    cadence: 'weekdays',
    durationPreference: null,
    voice: 'warm',
    stillness: 'off',
    lectio: false,
    calendarEnabled: true,
    healthEnabled: false,
    communicationEnabled: false,
    notifyOnSkip: false,
    examenEnabled: false,
    sabbathDay: 0,
    sabbathEnabled: false,
    sabbathSession: false,
    liturgicalSeasonsEnabled: false,
    minPerWeek: 2,
    adaptiveEnabled: true,
    rhythm: baseRhythm(),
    onboardedAt: '2026-07-01T00:00:00.000Z',
    timezone: 'UTC',
    language: 'en',
    translationId: 3034,
    updatedAt: '2026-07-20T10:00:00.000Z',
  };
}

/**
 * The server double: GET/PUT `/v1/preferences` against one stored row,
 * `/v1/connections` reporting an active Google connection (so the
 * reading toggle renders), everything else a rejection for a per-card
 * loader to absorb. PUT applies the body's recognized fields to the
 * stored row — including recomposing `rhythm` the way the real route
 * does — so what the shell adopts afterwards is an honest echo of
 * storage, not of the click.
 */
function installServer() {
  let row = baseRow();
  const putBodies: unknown[] = [];

  apiFetchMock.mockImplementation((async (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => {
    if (path === '/v1/preferences' && init?.method === 'PUT') {
      const body = (init.body ?? {}) as Partial<PreferencesResponseData> & {
        onboardingCompleted?: true;
        timezone?: string;
      };
      putBodies.push(init.body);
      const { onboardingCompleted: _oc, timezone: _tz, ...columns } = body;
      row = { ...row, ...columns };
      row.rhythm = {
        ...baseRhythm(),
        minPerWeek: row.minPerWeek,
        ...(row.adaptiveEnabled
          ? {}
          : { mode: 'fixed' as const, reason: 'fixed_by_user' as const }),
      };
      return { ok: true, data: row };
    }
    if (path === '/v1/preferences') return { ok: true, data: row };
    if (path === '/v1/connections') {
      return {
        ok: true,
        connections: [
          {
            provider: 'google_calendar',
            status: 'active',
            connectedAt: '2026-07-01T00:00:00.000Z',
            scopes: null,
          },
        ],
      };
    }
    const { ApiError } = await import('../src/api/client');
    throw new ApiError(404, 'not part of this test');
  }) as typeof apiFetch);

  return { putBodies };
}

async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  // The reading toggle appears once the connections fetch has landed.
  await screen.findByLabelText('Read my free/busy times');
}

function examenCheckbox(): HTMLInputElement {
  return screen.getByLabelText('Evening examen') as HTMLInputElement;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

afterEach(cleanup);

describe('staged form edits vs immediate-persist controls (#344)', () => {
  it('calendar toggle: a staged edit is neither committed nor lost', async () => {
    const { putBodies } = installServer();
    render(<App />);
    await openSettings();

    // Stage an edit without saving.
    expect(examenCheckbox().checked).toBe(false);
    fireEvent.click(examenCheckbox());
    expect(examenCheckbox().checked).toBe(true);

    // Flip the calendar reading toggle off.
    const toggle = screen.getByLabelText('Read my free/busy times') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(putBodies).toHaveLength(1));
    // NOT COMMITTED: the PUT carries exactly the consent field — no
    // examenEnabled, no window, no voice, nothing staged.
    expect(putBodies[0]).toEqual({ calendarEnabled: false });

    // The server's answer is adopted into the toggle...
    await waitFor(() =>
      expect((screen.getByLabelText('Read my free/busy times') as HTMLInputElement).checked).toBe(
        false,
      ),
    );
    // ...and NOT LOST: the staged edit still stands, unsaved.
    expect(examenCheckbox().checked).toBe(true);
  });

  it('rhythm "keep my schedule fixed": a staged edit is neither committed nor lost', async () => {
    const { putBodies } = installServer();
    render(<App />);
    await openSettings();

    fireEvent.click(examenCheckbox());
    expect(examenCheckbox().checked).toBe(true);

    fireEvent.click(screen.getByLabelText('Keep my schedule fixed'));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    // NOT COMMITTED: exactly the one rhythm field.
    expect(putBodies[0]).toEqual({ adaptiveEnabled: false });

    // The card re-renders from the server's rhythm slice, not the click...
    await screen.findByText(/Your schedule is fixed/);
    // ...and the staged edit is NOT LOST.
    expect(examenCheckbox().checked).toBe(true);
  });

  it('rhythm floor: a staged edit is neither committed nor lost', async () => {
    const { putBodies } = installServer();
    render(<App />);
    await openSettings();

    fireEvent.click(examenCheckbox());

    fireEvent.change(screen.getByLabelText('Never fewer than'), { target: { value: '3' } });

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ minPerWeek: 3 });

    await waitFor(() =>
      expect((screen.getByLabelText('Never fewer than') as HTMLSelectElement).value).toBe('3'),
    );
    expect(examenCheckbox().checked).toBe(true);
  });

  it('"Save changes" still commits the whole staged form — the fix must not make saving sparse', async () => {
    const { putBodies } = installServer();
    render(<App />);
    await openSettings();

    fireEvent.click(examenCheckbox());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    const body = putBodies[0] as Record<string, unknown>;
    // The staged edit is committed now, alongside the rest of the form.
    expect(body.examenEnabled).toBe(true);
    expect(body.windowStartLocal).toBe('09:00');
    expect(body.activeDays).toEqual([1, 2, 3, 4, 5]);
    // An ordinary save carries no consent statement (#299).
    expect('calendarEnabled' in body).toBe(false);

    await screen.findByText(/Saved\./);
  });
});

/**
 * The Connected-accounts card and its consent toggles (U5, #358), driven
 * through the real `<App />` so the sparse-PUT wiring — not just the pure
 * lib functions — is under test. `youversionConnection` and the two gates
 * ride the same `/v1/preferences` response the shell already reads.
 */
type YouVersionConnectionRow = { connected: boolean; displayName?: string };

function installYouVersionServer(opts: {
  connection?: YouVersionConnectionRow;
  yvWrite?: boolean;
  yvRead?: boolean;
  connect503?: boolean;
}) {
  let row: PreferencesResponseData & {
    youversionConnection?: YouVersionConnectionRow;
    yvWriteHighlights?: boolean;
    yvReadHighlights?: boolean;
  } = {
    ...baseRow(),
    youversionConnection: opts.connection,
    yvWriteHighlights: opts.yvWrite ?? false,
    yvReadHighlights: opts.yvRead ?? false,
  };
  const putBodies: unknown[] = [];
  const calls: string[] = [];

  apiFetchMock.mockImplementation((async (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/v1/preferences' && init?.method === 'PUT') {
      const body = (init.body ?? {}) as Partial<typeof row> & {
        onboardingCompleted?: true;
        timezone?: string;
      };
      putBodies.push(init.body);
      const { onboardingCompleted: _oc, timezone: _tz, ...columns } = body;
      row = { ...row, ...columns };
      return { ok: true, data: row };
    }
    if (path === '/v1/preferences') return { ok: true, data: row };
    if (path === '/v1/connections') return { ok: true, connections: [] };
    if (path === '/v1/youversion/connect' && init?.method === 'POST') {
      if (opts.connect503) {
        const { ApiError } = await import('../src/api/client');
        throw new ApiError(503, 'not configured', 'UNAVAILABLE');
      }
      return { ok: true, authUrl: 'https://youversion.test/authorize' };
    }
    if (path === '/v1/youversion/connection' && init?.method === 'DELETE') {
      row = { ...row, youversionConnection: { connected: false } };
      return { ok: true };
    }
    const { ApiError } = await import('../src/api/client');
    throw new ApiError(404, 'not part of this test');
  }) as typeof apiFetch);

  return { putBodies, calls };
}

async function openSettingsNoCalendar() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  await screen.findByText('YouVersion');
}

const WRITE_COPY = 'After each devotional, save its verse to your YouVersion highlights.';
const READ_COPY = "Let Wellspring notice verses you've highlighted and gently weave them in.";
const HONESTY_LINE =
  'Wellspring only reads and adds highlights — never your notes, plans, or anything else.';

describe('Connected accounts — YouVersion card (#358)', () => {
  afterEach(() => window.sessionStorage.clear());

  it('not-connected: offers "Sign in with YouVersion" and no consent toggles', async () => {
    installYouVersionServer({ connection: { connected: false } });
    render(<App />);
    await openSettingsNoCalendar();

    const button = screen.getByRole('button', { name: 'Sign in with YouVersion' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByLabelText(WRITE_COPY)).toBeNull();
    expect(screen.queryByLabelText(READ_COPY)).toBeNull();
    // The honesty line is always present.
    expect(screen.getByText(HONESTY_LINE)).toBeTruthy();
  });

  it('connected: shows the display name, both toggles at their stored state, and Disconnect', async () => {
    installYouVersionServer({
      connection: { connected: true, displayName: 'Ada Lovelace' },
      yvWrite: true,
      yvRead: false,
    });
    render(<App />);
    await openSettingsNoCalendar();

    expect(screen.getByText('Connected as Ada Lovelace')).toBeTruthy();
    expect((screen.getByLabelText(WRITE_COPY) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(READ_COPY) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByText(HONESTY_LINE)).toBeTruthy();
  });

  it('connected without a name reads as a plain "Connected"', async () => {
    installYouVersionServer({ connection: { connected: true } });
    render(<App />);
    await openSettingsNoCalendar();
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('503 (not configured): the connect row disables with a "coming soon" note, not an error', async () => {
    installYouVersionServer({ connection: { connected: false }, connect503: true });
    render(<App />);
    await openSettingsNoCalendar();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with YouVersion' }));

    await screen.findByText('Connecting your YouVersion account is coming soon.');
    expect(
      (screen.getByRole('button', { name: 'Sign in with YouVersion' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // No error banner — a 503 is "coming soon", not a failure.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a consent toggle produces a SPARSE PUT — exactly that field, and staged edits are neither committed nor lost', async () => {
    const { putBodies } = installYouVersionServer({
      connection: { connected: true, displayName: 'Ada' },
      yvWrite: false,
    });
    render(<App />);
    await openSettingsNoCalendar();

    // Stage a form edit that must NOT ride the consent PUT.
    expect(examenCheckbox().checked).toBe(false);
    fireEvent.click(examenCheckbox());
    expect(examenCheckbox().checked).toBe(true);

    const writeToggle = screen.getByLabelText(WRITE_COPY) as HTMLInputElement;
    expect(writeToggle.checked).toBe(false);
    fireEvent.click(writeToggle);

    await waitFor(() => expect(putBodies).toHaveLength(1));
    // MUTATION-CHECK: exactly the one consent field. A regression that
    // re-sent the whole staged form (examenEnabled, window, activeDays, …)
    // fails here.
    expect(putBodies[0]).toEqual({ yvWriteHighlights: true });

    // The server's answer is adopted into the toggle...
    await waitFor(() =>
      expect((screen.getByLabelText(WRITE_COPY) as HTMLInputElement).checked).toBe(true),
    );
    // ...and the staged edit is NOT LOST.
    expect(examenCheckbox().checked).toBe(true);
  });

  it('the read toggle sends only its own field too', async () => {
    const { putBodies } = installYouVersionServer({
      connection: { connected: true, displayName: 'Ada' },
      yvRead: false,
    });
    render(<App />);
    await openSettingsNoCalendar();

    fireEvent.click(screen.getByLabelText(READ_COPY));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({ yvReadHighlights: true });
  });

  it('Disconnect DELETEs, re-reads preferences, and returns the card to not-connected', async () => {
    const { calls } = installYouVersionServer({
      connection: { connected: true, displayName: 'Ada' },
    });
    render(<App />);
    await openSettingsNoCalendar();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await screen.findByRole('button', { name: 'Sign in with YouVersion' });
    expect(calls).toContain('DELETE /v1/youversion/connection');
    // The connection fact came from a fresh GET, not a local guess (#213).
    expect(calls.filter((c) => c === 'GET /v1/preferences').length).toBeGreaterThanOrEqual(2);
  });

  it('a success callback flash lands the user on Settings with a quiet confirmation', async () => {
    window.sessionStorage.setItem(
      'kairos.youversionCallback',
      JSON.stringify({ status: 'success' }),
    );
    installYouVersionServer({ connection: { connected: true, displayName: 'Ada' } });
    render(<App />);

    // No manual navigation: the pending flash routes the shell to Settings.
    await screen.findByText('Your YouVersion account is connected.');
    expect(screen.getByText('Connected as Ada')).toBeTruthy();
    // And it is one-shot — the flash was consumed, so it does not replay.
    expect(window.sessionStorage.getItem('kairos.youversionCallback')).toBeNull();
  });

  it('an older server that omits the connection renders no card at all (#244)', async () => {
    // No `youversionConnection` on the row → unsupported → nothing rendered.
    installYouVersionServer({ connection: undefined });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByText('YouVersion')).toBeNull();
    expect(screen.queryByText(HONESTY_LINE)).toBeNull();
  });
});
