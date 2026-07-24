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
