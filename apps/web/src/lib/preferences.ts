/**
 * The web client's preference model and its mapping to/from
 * `GET`/`PUT /v1/preferences`.
 *
 * ## There is no local source of truth here (issue #225, #195)
 *
 * This module deliberately exposes only two pure functions —
 * `fromServer` and `toUpdateRequest` — and no store. Every value the UI
 * renders came from a `GET /v1/preferences` in this page load, and every
 * edit goes back through `PUT /v1/preferences`. A user who onboarded on
 * iOS sees their real window, days, and voice here because those are
 * literally the server's values, not a cache that agrees with them most
 * of the time. That is the whole point of #195: two clients that disagree
 * are worse than one client.
 *
 * ## Why a `WebPreferences` shape at all, rather than editing the wire type
 *
 * `PreferencesResponseData` is the full stored row (18 fields, including
 * several the onboarding UI does not surface) and
 * `PreferencesUpdateRequest` is a sparse patch where "absent" and "null"
 * mean different things. Neither is a good thing to bind form controls
 * to. `WebPreferences` is the small total record the form edits; the two
 * functions below are the only places the lossy bits live, which is also
 * what makes them testable without a browser.
 *
 * ## Mapping notes (compare `HTTPPreferencesClient.swift`, which does the
 * same job for iOS — the two must not drift)
 *
 *  - **Hours.** `windowStartLocal`/`windowEndLocal` are Postgres `time`
 *    values (`HH:MM` or `HH:MM:SS`). Wellspring has never offered sub-hour
 *    precision on either client, so only the hour component is read and
 *    minutes are always written as `:00` — same as iOS.
 *  - **Days.** iOS carries `Weekday` as `Calendar.weekday` (Sun=1..Sat=7)
 *    and offsets by one at the wire boundary. This client uses the wire
 *    convention (0=Sunday..6=Saturday) natively, so there is no offset to
 *    get backwards.
 *  - **Cadence** is a derived label over the day set, never an
 *    independent setting (K2, #188). It is computed with the *shared*
 *    `cadenceForActiveDays`, which is the same function the server
 *    re-applies on write — so the two ends cannot hold different theories
 *    about which field is authoritative. On read it is ignored entirely:
 *    rows written before #188 genuinely carry a contradictory pair
 *    (`cadence: 'daily'` beside `activeDays: [1,2,3,4,5]` was the column
 *    default), and `activeDays` is the half that the daily run reads.
 *  - **Duration.** `'auto'` is the UI name for a stored `null`
 *    (migration 1721500000000, #202). Unlike iOS — which *omits* the key
 *    for auto and therefore cannot express "switch me back to auto" once
 *    a real format is stored — this client sends an explicit `null`,
 *    which the schema accepts (`.nullable().optional()`). Absent means
 *    "no opinion"; null means "auto". We always have an opinion, because
 *    the user is looking at the control.
 *  - **Voice.** The column holds either a picker label
 *    (`warm`/`calm`/`bright`, what iOS writes) or a real Chirp 3 HD voice
 *    id. An unrecognized value is preserved verbatim rather than snapped
 *    to a default, so opening the web settings page cannot silently
 *    overwrite a voice chosen out of band. The form surfaces it as an
 *    extra option instead.
 *  - **Timezone** is push-only. It writes `users.timezone` (#187) and is
 *    not echoed in the response, so this client sends the browser's
 *    `Intl` zone on every save exactly as iOS sends the device zone, and
 *    the UI presents it as detected-and-sent rather than as a picker it
 *    cannot pre-fill from the server.
 *  - **`tradition`/`translation` are not here.** They live on `users`,
 *    not `preferences`, and no endpoint writes them (see the header
 *    comment in shared-contracts' `preferences.ts`, and #89). See
 *    `TRADITION_TRANSLATION_NOTE` below.
 */
import {
  cadenceForActiveDays,
  TraditionSchema,
  VOICE_CATALOG,
  type Cadence,
  type DevotionalFormat,
  type PreferencesResponseData,
  type PreferencesUpdateRequest,
  type Stillness,
  type Tradition,
  type VoiceLabel,
} from '@kairos/shared-contracts';

/** `'auto'` is the UI's name for a stored `durationPreference` of `null`. */
export type DurationChoice = 'auto' | DevotionalFormat;

export const DURATION_CHOICES: readonly { value: DurationChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'micro', label: '2 min' },
  { value: 'short', label: '5 min' },
  { value: 'standard', label: '10 min' },
  { value: 'extended', label: '15 min' },
] as const;

/** The three picker labels iOS writes. The column also accepts real voice ids. */
export const VOICE_CHOICES: readonly { value: string; label: string }[] = [
  { value: 'warm', label: 'Warm' },
  { value: 'calm', label: 'Calm' },
  { value: 'bright', label: 'Bright' },
] as const;

/**
 * Real Chirp 3 HD voice id -> the picker label that resolves to it: the
 * inverse of shared-contracts' `VOICE_CATALOG`, derived from it so the two
 * cannot drift. `en-US-Chirp3-HD-Achernar` -> `warm`, and so on.
 */
const VOICE_ID_TO_LABEL: Readonly<Record<string, VoiceLabel>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(VOICE_CATALOG) as [VoiceLabel, string][]).map(([label, voiceId]) => [
      voiceId,
      label,
    ]),
  ),
) as Readonly<Record<string, VoiceLabel>>;

/**
 * The picker label a stored voice belongs to, if any. Accepts both stored
 * representations of a voice — a label (`warm`/`calm`/`bright`, what iOS
 * writes, returned as-is) or a real Chirp 3 HD id (the column default and
 * any pre-picker row, mapped back through the catalog). Returns `undefined`
 * only for a value from neither set.
 */
export function voiceLabelFor(stored: string): VoiceLabel | undefined {
  if (VOICE_CHOICES.some((choice) => choice.value === stored)) return stored as VoiceLabel;
  return VOICE_ID_TO_LABEL[stored];
}

/**
 * A human label for whatever is stored in `voice`, never the raw id (#302).
 * A recognized label or catalog id resolves to its friendly picker label;
 * an out-of-band id this UI cannot name is shown as a neutral placeholder
 * rather than leaking `en-US-Chirp3-HD-...` into the dropdown.
 */
export function voiceDisplayLabel(stored: string): string {
  const label = voiceLabelFor(stored);
  if (label) return VOICE_CHOICES.find((choice) => choice.value === label)!.label;
  return 'Custom voice';
}

export const STILLNESS_CHOICES: readonly { value: Stillness; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'brief', label: 'Brief (15s)' },
  { value: 'full', label: 'Full (45s)' },
] as const;

export const CADENCE_PRESETS: readonly { value: Cadence; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'custom', label: 'Custom' },
] as const;

/**
 * Shown verbatim in the UI next to the (disabled) tradition/translation
 * rows. Stated rather than hidden on purpose: #193's lesson is that a
 * setting which appears to work and doesn't is more corrosive than an
 * obviously missing one, and a tradition picker that evaporates on reload
 * would be exactly the former.
 */
export const TRADITION_TRANSLATION_NOTE =
  'Tradition and translation are stored on your profile, not with these preferences, and no API can change them yet — so they are shown here but not editable on web.';

/** Friendly label per `Tradition`. The exhaustive `Record` keying is the
 *  lockstep guard: a value added to `TraditionSchema` (#192 capped it at
 *  six) will not type-check here until it is given a label, so the web
 *  picker can never fall a tradition short and render an empty selection. */
const TRADITION_LABELS: Readonly<Record<Tradition, string>> = Object.freeze({
  evangelical: 'Evangelical',
  catholic: 'Catholic',
  mainline: 'Mainline',
  anglican: 'Anglican',
  orthodox: 'Orthodox',
  general: 'General',
});

/**
 * Every tradition the shared model carries, in the schema's own order, each
 * with a friendly label. Built from `TraditionSchema.options` rather than
 * hand-listed so the web dropdown stays complete as the enum grows (#192
 * added Anglican and Orthodox); a value the list omitted would render as a
 * broken, empty selection for that user (#302).
 */
export const TRADITION_CHOICES: readonly { value: Tradition; label: string }[] =
  TraditionSchema.options.map((value) => ({ value, label: TRADITION_LABELS[value] }));

/** The total record the form binds to. Every field round-trips through `/v1/preferences`. */
export interface WebPreferences {
  windowStartHour: number;
  windowEndHour: number;
  /** 0=Sunday..6=Saturday — the wire convention, used natively. */
  activeDays: number[];
  duration: DurationChoice;
  voice: string;
  stillness: Stillness;
  examenEnabled: boolean;
}

/**
 * Only ever used before the first `GET` resolves (and as the repair
 * target in `validate`). It is NOT a fallback the UI can persist behind
 * the user's back: a failed `GET` renders an error, not these values, so
 * a network blip can never overwrite real server state with defaults.
 * Matches `OnboardingPreferences.defaults` on iOS and the column defaults
 * in migration 1720000000000.
 */
export const DEFAULT_PREFERENCES: WebPreferences = {
  windowStartHour: 9,
  windowEndHour: 17,
  // All seven (N3, #262). Mon–Fri left Wellspring silent on the Lord's Day
  // out of the box, and the empty state said so: "Your next devotional is
  // Monday." The gap-finding mechanic is a workday one, but a default is
  // a statement, and that one said the faith is a workday supplement.
  // Migration 1722100000000 makes the same change to the column default;
  // neither touches an existing user's stored days.
  activeDays: [0, 1, 2, 3, 4, 5, 6],
  duration: 'auto',
  voice: 'warm',
  stillness: 'off',
  examenEnabled: false,
};

const DURATION_VALUES = new Set<string>(['micro', 'short', 'standard', 'extended']);
const STILLNESS_VALUES = new Set<string>(['off', 'brief', 'full']);

/** `'09:00:00'` / `'09:00'` -> `9`; anything unparseable -> `undefined`. */
export function hourFromLocalTime(value: string): number | undefined {
  const head = value.split(':')[0];
  if (head === undefined) return undefined;
  const hour = Number.parseInt(head, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  return hour;
}

/** `9` -> `'09:00'`. Minutes are always `:00` — see the module header. */
export function localTimeFromHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Clamps/repairs into a state that is always safe to render and to send,
 * mirroring `OnboardingPreferences.validated()` on iOS:
 *   - hours clamped to 0..23, and the end pushed past the start so a
 *     zero-width or inverted window can never round-trip
 *   - an empty day set falls back to Mon–Fri. Since #188 `activeDays: []`
 *     is a 400 ("never generate again, silently"), so this is a storage
 *     safety net for a legacy or corrupt row — the day control itself
 *     refuses the last deselection at the click, so the empty state is
 *     never *created* by the UI.
 */
export function validate(prefs: WebPreferences): WebPreferences {
  const clamp = (h: number) => Math.min(Math.max(Math.trunc(h), 0), 23);
  let start = clamp(prefs.windowStartHour);
  let end = clamp(prefs.windowEndHour);
  if (start >= end) {
    end = Math.min(start + 1, 23);
    if (start >= end) start = Math.max(end - 1, 0);
  }
  const days = [
    ...new Set(prefs.activeDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
  ].sort((a, b) => a - b);
  return {
    ...prefs,
    windowStartHour: start,
    windowEndHour: end,
    activeDays: days.length > 0 ? days : [...DEFAULT_PREFERENCES.activeDays],
  };
}

/**
 * The server row -> the form model. Unrecognized enum-ish strings fall
 * back rather than throw: the columns behind `voice`/`stillness`/`cadence`
 * are plain `text` with no DB constraint, so a stale or out-of-band value
 * must render rather than take the whole page down.
 */
export function fromServer(data: PreferencesResponseData): WebPreferences {
  return validate({
    windowStartHour:
      hourFromLocalTime(data.windowStartLocal) ?? DEFAULT_PREFERENCES.windowStartHour,
    windowEndHour: hourFromLocalTime(data.windowEndLocal) ?? DEFAULT_PREFERENCES.windowEndHour,
    // `data.cadence` is deliberately not read — see the module header.
    activeDays: [...data.activeDays],
    duration:
      data.durationPreference !== null && DURATION_VALUES.has(data.durationPreference)
        ? data.durationPreference
        : 'auto',
    // A stored voice is normalized to its picker label when it maps to one
    // — a real catalog id like `en-US-Chirp3-HD-Achernar` becomes `warm`, so
    // the dropdown selects a friendly option instead of leaking the id
    // (#302), and the round-trip is byte-identical because the server
    // resolves label and id to the same voice. An id the catalog does not
    // name is still preserved verbatim rather than snapped to a default, so
    // opening this page cannot silently overwrite a voice chosen out of band.
    voice:
      voiceLabelFor(data.voice) ?? (data.voice.length > 0 ? data.voice : DEFAULT_PREFERENCES.voice),
    stillness: STILLNESS_VALUES.has(data.stillness)
      ? (data.stillness as Stillness)
      : DEFAULT_PREFERENCES.stillness,
    examenEnabled: data.examenEnabled,
  });
}

export interface UpdateOptions {
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone` — push-only (#187). */
  timezone?: string;
  /**
   * Only ever `true` or absent. The schema is `z.literal(true).optional()`
   * on purpose — there is no wire representation of "un-onboard me" — so a
   * literal `false` is a 400 rather than a no-op.
   */
  onboardingCompleted?: boolean;
  /**
   * A genuine consent statement, sent only when the user actually made
   * one (connected or explicitly skipped the calendar). Absent otherwise,
   * so an ordinary settings save cannot restate — and thereby resurrect —
   * a consent decision made on the other surface.
   */
  calendarEnabled?: boolean;
}

/** The form model -> a `PUT /v1/preferences` body. */
export function toUpdateRequest(
  prefs: WebPreferences,
  options: UpdateOptions = {},
): PreferencesUpdateRequest {
  const v = validate(prefs);
  const body: PreferencesUpdateRequest = {
    windowStartLocal: localTimeFromHour(v.windowStartHour),
    windowEndLocal: localTimeFromHour(v.windowEndHour),
    activeDays: v.activeDays,
    // Sent for the benefit of other readers of the column; the server
    // recomputes it from `activeDays` regardless (K2, #188).
    cadence: cadenceForActiveDays(v.activeDays),
    // Explicit `null` for auto — see the module header for why this
    // differs from iOS.
    durationPreference: v.duration === 'auto' ? null : v.duration,
    voice: v.voice,
    stillness: v.stillness,
    examenEnabled: v.examenEnabled,
  };
  if (options.timezone) body.timezone = options.timezone;
  if (options.calendarEnabled !== undefined) body.calendarEnabled = options.calendarEnabled;
  if (options.onboardingCompleted) body.onboardingCompleted = true;
  return body;
}

/** The label for the current day set — a readout, not a control (K2, #188). */
export function cadenceLabel(activeDays: readonly number[]): Cadence {
  return cadenceForActiveDays(activeDays);
}

/** The browser's own IANA zone, the web equivalent of `TimeZone.current.identifier`. */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
