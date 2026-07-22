/**
 * `getFreeBusy` — the decoder that makes the contract's guarantee real on
 * the client side (M2–M5, #255).
 *
 * The bodies below are the shapes `apps/api/src/routes/calendarFreeBusy.ts`
 * actually sends, read off that handler rather than invented: `{ ok: true,
 * data: { status, range, busy? } }` for the three 200s, and an
 * `ErrorEnvelope` for the 400 and 502. `apiFetch` is stubbed rather than
 * the network, same as `dashboardApi.test.ts`, because importing the real
 * client pulls in Firebase config that these tests have nothing to say
 * about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FREEBUSY_MAX_RANGE_DAYS } from '@kairos/shared-contracts';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

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
  return { ApiError, apiFetch };
});

const { getFreeBusy, FREEBUSY_RANGE_MESSAGE } = await import('../src/api/calendar');
const { ApiError } = await import('../src/api/client');
const { resolveBusy } = await import('../src/lib/calendarGrid');

const RANGE = {
  from: '2026-07-19T05:00:00.000Z',
  to: '2026-07-20T05:00:00.000Z',
  timeZone: 'America/Chicago',
};

beforeEach(() => {
  apiFetch.mockReset();
});

describe('getFreeBusy', () => {
  it('sends the range as encoded query parameters the route can parse', () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: 'ok', range: RANGE, busy: [] } });
    return getFreeBusy(RANGE.from, RANGE.to).then(() => {
      // The route requires both and 400s without them, so this asserts the
      // request the server actually accepts rather than that a call happened.
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/calendar/freebusy?from=${encodeURIComponent(RANGE.from)}&to=${encodeURIComponent(RANGE.to)}`,
      );
    });
  });

  it('returns the ok variant with its busy blocks', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        status: 'ok',
        range: RANGE,
        busy: [{ start: '2026-07-19T14:00:00Z', end: '2026-07-19T15:00:00Z' }],
      },
    });
    const data = await getFreeBusy(RANGE.from, RANGE.to);
    expect(data.status).toBe('ok');
    if (data.status === 'ok') expect(data.busy).toHaveLength(1);
  });

  it.each(['consent_disabled', 'not_connected'] as const)(
    'returns %s as a normal answer, not an error — and with no busy array',
    async (status) => {
      apiFetch.mockResolvedValue({ ok: true, data: { status, range: RANGE } });
      const data = await getFreeBusy(RANGE.from, RANGE.to);
      expect(data.status).toBe(status);
      // The decoded value cannot be mapped over, which is the guarantee.
      expect('busy' in data).toBe(false);
      expect(resolveBusy(data).kind).toBe('unknown');
    },
  );

  it('strips a busy array the server would never send on a degraded variant', async () => {
    // Defence in depth against a future server bug rather than a shape we
    // expect: the decoder is what stops it reaching a view.
    apiFetch.mockResolvedValue({
      ok: true,
      data: { status: 'consent_disabled', range: RANGE, busy: [{ start: 'x', end: 'y' }] },
    });
    const data = await getFreeBusy(RANGE.from, RANGE.to);
    expect('busy' in data).toBe(false);
  });

  it('translates the range 400 into something a user can read', async () => {
    apiFetch.mockRejectedValue(
      new ApiError(400, 'Wellspring could not accept those settings.', 'INVALID_ARGUMENT'),
    );
    await expect(getFreeBusy(RANGE.from, RANGE.to)).rejects.toThrow(FREEBUSY_RANGE_MESSAGE);
    // Names the real cap, so a reader of the message can check it against
    // the contract rather than take a round number on trust.
    expect(FREEBUSY_RANGE_MESSAGE).toContain(String(FREEBUSY_MAX_RANGE_DAYS));
  });

  it('lets a 502 through to the card’s error state rather than dressing it as empty', async () => {
    // The route returns 502 when Google could not be read at all. Rendering
    // that as an empty calendar would draw a packed day as wide open, which
    // is exactly what the route's own comment refuses to do server-side.
    apiFetch.mockRejectedValue(new ApiError(502, 'Wellspring is having trouble right now.'));
    await expect(getFreeBusy(RANGE.from, RANGE.to)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a body it cannot decode instead of returning a half-parsed calendar', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { status: 'sideways', range: RANGE } });
    await expect(getFreeBusy(RANGE.from, RANGE.to)).rejects.toThrow(/shape this app does not/);
  });

  it('rejects an ok variant that arrived without its busy array', async () => {
    // `busy` is required on `ok`. A response missing it is not "an empty
    // calendar" — it is a response we do not understand, and the two must
    // not collapse into the same render.
    apiFetch.mockResolvedValue({ ok: true, data: { status: 'ok', range: RANGE } });
    await expect(getFreeBusy(RANGE.from, RANGE.to)).rejects.toThrow(/shape this app does not/);
  });
});
