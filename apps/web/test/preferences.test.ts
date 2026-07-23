import { describe, expect, it } from 'vitest';
import type { PreferencesResponseData } from '@kairos/shared-contracts';
import { TraditionSchema, VOICE_CATALOG } from '@kairos/shared-contracts';
import {
  DEFAULT_PREFERENCES,
  TRADITION_CHOICES,
  fromServer,
  hourFromLocalTime,
  localTimeFromHour,
  toUpdateRequest,
  validate,
  voiceDisplayLabel,
  voiceLabelFor,
  type WebPreferences,
} from '../src/lib/preferences';

/**
 * A full server row. Written out rather than partially cast so that a
 * field added to `PreferencesResponseDataSchema` breaks this file — the
 * whole point of #195's "preference drift across clients" warning is that
 * a new preference must not be able to land on one surface silently.
 */
function serverRow(overrides: Partial<PreferencesResponseData> = {}): PreferencesResponseData {
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
    onboardedAt: null,
    timezone: 'America/Chicago',
    // #314 added these to the payload; the web *surface* for them is O5
    // (kairos-devotional #317) — until it lands, web reads them nowhere
    // and the disabled translation select keeps its hard-coded display.
    language: 'en',
    translationId: 3034,
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('hour <-> HH:MM', () => {
  it('reads the hour from both Postgres time shapes', () => {
    expect(hourFromLocalTime('09:00:00')).toBe(9);
    expect(hourFromLocalTime('09:00')).toBe(9);
    expect(hourFromLocalTime('00:00:00')).toBe(0);
    expect(hourFromLocalTime('23:30')).toBe(23);
  });

  it('rejects values it cannot honestly read rather than guessing', () => {
    expect(hourFromLocalTime('')).toBeUndefined();
    expect(hourFromLocalTime('nonsense')).toBeUndefined();
    expect(hourFromLocalTime('24:00')).toBeUndefined();
    expect(hourFromLocalTime('-1:00')).toBeUndefined();
  });

  it('always writes zero minutes', () => {
    expect(localTimeFromHour(9)).toBe('09:00');
    expect(localTimeFromHour(17)).toBe('17:00');
    expect(localTimeFromHour(0)).toBe('00:00');
  });
});

describe('validate', () => {
  const base: WebPreferences = { ...DEFAULT_PREFERENCES };

  it('repairs an inverted window rather than sending it', () => {
    const out = validate({ ...base, windowStartHour: 17, windowEndHour: 9 });
    expect(out.windowStartHour).toBe(17);
    expect(out.windowEndHour).toBe(18);
  });

  it('never produces a zero-width window, even at the top of the day', () => {
    const out = validate({ ...base, windowStartHour: 23, windowEndHour: 23 });
    expect(out.windowStartHour).toBeLessThan(out.windowEndHour);
    expect(out.windowEndHour).toBeLessThanOrEqual(23);
  });

  it('clamps out-of-range hours', () => {
    const out = validate({ ...base, windowStartHour: -4, windowEndHour: 99 });
    expect(out.windowStartHour).toBe(0);
    expect(out.windowEndHour).toBe(23);
  });

  it('repairs an empty day set to the default, which is now all seven (#262)', () => {
    // An empty `activeDays` is a 400 since #188, so this repair only ever
    // sees a legacy row. It follows `DEFAULT_PREFERENCES` deliberately —
    // the repair target and the default are the same answer to the same
    // question ("what does Wellspring do when nobody has said?"), and letting
    // them diverge is how a user gets silently repaired to a schedule the
    // product no longer considers correct.
    expect(validate({ ...base, activeDays: [] }).activeDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(validate({ ...base, activeDays: [] }).activeDays).toEqual([
      ...DEFAULT_PREFERENCES.activeDays,
    ]);
  });

  it('de-duplicates, sorts, and drops out-of-range days', () => {
    expect(validate({ ...base, activeDays: [5, 1, 1, 9, -2, 0] }).activeDays).toEqual([0, 1, 5]);
  });
});

describe('fromServer', () => {
  it('populates from the server row, not from defaults', () => {
    const prefs = fromServer(
      serverRow({
        windowStartLocal: '07:00:00',
        windowEndLocal: '12:00:00',
        activeDays: [0, 6],
        durationPreference: 'short',
        voice: 'calm',
        stillness: 'full',
        examenEnabled: true,
      }),
    );
    expect(prefs).toEqual({
      windowStartHour: 7,
      windowEndHour: 12,
      activeDays: [0, 6],
      duration: 'short',
      voice: 'calm',
      stillness: 'full',
      examenEnabled: true,
    });
  });

  it('reads null durationPreference as auto', () => {
    expect(fromServer(serverRow({ durationPreference: null })).duration).toBe('auto');
  });

  it('ignores the stored cadence, which can legitimately contradict the days', () => {
    // The pre-#188 column default: cadence 'daily' beside Mon-Fri.
    const prefs = fromServer(serverRow({ cadence: 'daily', activeDays: [1, 2, 3, 4, 5] }));
    expect(prefs.activeDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizes a known raw voice id to its picker label rather than leaking the id (#302)', () => {
    // Achernar is the column default and what most rows carry; it must show
    // as "Warm", not as `en-US-Chirp3-HD-Achernar`.
    expect(fromServer(serverRow({ voice: 'en-US-Chirp3-HD-Achernar' })).voice).toBe('warm');
    expect(fromServer(serverRow({ voice: 'en-US-Chirp3-HD-Kore' })).voice).toBe('calm');
    expect(fromServer(serverRow({ voice: 'en-US-Chirp3-HD-Zubenelgenubi' })).voice).toBe('bright');
  });

  it('preserves a voice id the catalog cannot name instead of overwriting it', () => {
    // An out-of-band id no picker label maps to is still kept verbatim, so
    // opening the page never snaps it to a default.
    expect(fromServer(serverRow({ voice: 'en-US-Chirp3-HD-Sadaltager' })).voice).toBe(
      'en-US-Chirp3-HD-Sadaltager',
    );
  });

  it('falls back for an unrecognized stillness rather than throwing', () => {
    expect(fromServer(serverRow({ stillness: 'banana' })).stillness).toBe('off');
  });
});

describe('toUpdateRequest', () => {
  it('derives cadence from the days with the shared function', () => {
    expect(toUpdateRequest({ ...DEFAULT_PREFERENCES, activeDays: [1, 2, 3, 4, 5] }).cadence).toBe(
      'weekdays',
    );
    expect(
      toUpdateRequest({ ...DEFAULT_PREFERENCES, activeDays: [0, 1, 2, 3, 4, 5, 6] }).cadence,
    ).toBe('daily');
    expect(toUpdateRequest({ ...DEFAULT_PREFERENCES, activeDays: [2, 4] }).cadence).toBe('custom');
  });

  it('sends an explicit null for auto, so a user can switch back to it', () => {
    const body = toUpdateRequest({ ...DEFAULT_PREFERENCES, duration: 'auto' });
    expect(body.durationPreference).toBeNull();
    expect('durationPreference' in body).toBe(true);
  });

  it('sends a real format when one is chosen', () => {
    expect(
      toUpdateRequest({ ...DEFAULT_PREFERENCES, duration: 'extended' }).durationPreference,
    ).toBe('extended');
  });

  it('omits consent unless the user actually made a statement', () => {
    expect('calendarEnabled' in toUpdateRequest(DEFAULT_PREFERENCES)).toBe(false);
    expect(toUpdateRequest(DEFAULT_PREFERENCES, { calendarEnabled: false }).calendarEnabled).toBe(
      false,
    );
    expect(toUpdateRequest(DEFAULT_PREFERENCES, { calendarEnabled: true }).calendarEnabled).toBe(
      true,
    );
  });

  it('never sends onboardingCompleted: false — the schema is z.literal(true) and a false is a 400', () => {
    expect('onboardingCompleted' in toUpdateRequest(DEFAULT_PREFERENCES)).toBe(false);
    expect(
      'onboardingCompleted' in toUpdateRequest(DEFAULT_PREFERENCES, { onboardingCompleted: false }),
    ).toBe(false);
    expect(
      toUpdateRequest(DEFAULT_PREFERENCES, { onboardingCompleted: true }).onboardingCompleted,
    ).toBe(true);
  });

  it('sends the timezone only when one was detected', () => {
    expect('timezone' in toUpdateRequest(DEFAULT_PREFERENCES)).toBe(false);
    expect(toUpdateRequest(DEFAULT_PREFERENCES, { timezone: 'America/Chicago' }).timezone).toBe(
      'America/Chicago',
    );
  });

  it('validates before sending, so an inverted window never reaches the API', () => {
    const body = toUpdateRequest({
      ...DEFAULT_PREFERENCES,
      windowStartHour: 17,
      windowEndHour: 9,
    });
    expect(body.windowStartLocal).toBe('17:00');
    expect(body.windowEndLocal).toBe('18:00');
  });
});

describe('voice labels (#302)', () => {
  it('maps every picker label and every catalog id back to a label', () => {
    expect(voiceLabelFor('warm')).toBe('warm');
    expect(voiceLabelFor('calm')).toBe('calm');
    expect(voiceLabelFor('bright')).toBe('bright');
    // The whole catalog resolves — derived from VOICE_CATALOG so it cannot drift.
    for (const [label, voiceId] of Object.entries(VOICE_CATALOG)) {
      expect(voiceLabelFor(voiceId)).toBe(label);
    }
  });

  it('returns undefined for a value from neither the labels nor the catalog', () => {
    expect(voiceLabelFor('en-US-Chirp3-HD-Sadaltager')).toBeUndefined();
    expect(voiceLabelFor('')).toBeUndefined();
  });

  it('never displays a raw voice id — a known id shows its label, an unknown one a placeholder', () => {
    expect(voiceDisplayLabel('en-US-Chirp3-HD-Achernar')).toBe('Warm');
    expect(voiceDisplayLabel('warm')).toBe('Warm');
    const unknown = voiceDisplayLabel('en-US-Chirp3-HD-Sadaltager');
    expect(unknown).toBe('Custom voice');
    expect(unknown).not.toMatch(/Chirp3/);
  });
});

describe('tradition choices (#192, #302)', () => {
  it('offers every tradition the shared model carries, not just General', () => {
    const values = TRADITION_CHOICES.map((choice) => choice.value);
    expect(values).toEqual([...TraditionSchema.options]);
    expect(values).toContain('anglican');
    expect(values).toContain('orthodox');
  });

  it('gives each tradition a non-empty friendly label so no value renders empty', () => {
    for (const choice of TRADITION_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.label).not.toBe(choice.value);
    }
  });
});

describe('round trip', () => {
  /**
   * The actual #195 acceptance claim, in miniature: what iOS wrote is what
   * web shows, and what web sends back is the same choice.
   */
  it('server row -> form -> update body preserves every field the wire carries', () => {
    const row = serverRow({
      windowStartLocal: '06:00:00',
      windowEndLocal: '14:00:00',
      activeDays: [1, 3, 5],
      durationPreference: 'standard',
      voice: 'bright',
      stillness: 'brief',
      examenEnabled: true,
    });
    const body = toUpdateRequest(fromServer(row));
    expect(body.windowStartLocal).toBe('06:00');
    expect(body.windowEndLocal).toBe('14:00');
    expect(body.activeDays).toEqual([1, 3, 5]);
    expect(body.cadence).toBe('custom');
    expect(body.durationPreference).toBe('standard');
    expect(body.voice).toBe('bright');
    expect(body.stillness).toBe('brief');
    expect(body.examenEnabled).toBe(true);
  });
});
