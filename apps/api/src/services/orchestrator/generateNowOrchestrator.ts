/**
 * generateNowOrchestrator — the vertical slice docs/14_IMPROVEMENT_REVIEW.md
 * §4.1 calls "the highest-priority build item": chains together every stage
 * of docs/02_ARCHITECTURE.md §3.1.
 *
 * Steps (Architecture §3.1):
 *   1. Load prefs (tradition/translation/preferredVersionId) — defaults to
 *      general/BSB/3034 when no preferences row exists yet (docs/14 §3.5:
 *      "return defaults instead of 404").
 *   2. DevotionalEngine.generate() — real Gloo + YouVersion tool loop (or
 *      fixture fallback; DevotionalEngine itself guarantees a valid
 *      DevotionalOutput either way).
 *   3. TtsService.synthesize() — best-effort. A TTS failure must not lose
 *      the generated devotional text.
 *   4. AudioStorage.upload() — only reached if synthesis succeeded.
 *   5. Create the devotional row (devotionalsRepository) and session row
 *      (sessionsRepository) with a fresh UUIDv4 token and a placeholder
 *      expiry of now + 48h.
 *   6. Calendar integration (optional, non-blocking): load the user's
 *      Google Calendar connection, decrypt the refresh token, call freeBusy
 *      for tomorrow's window, find the best gap, insert a Wellspring event,
 *      update session expiry to event-end + 48h, and store the calendar
 *      event record. Any failure in this step logs and continues — the
 *      devotional and session are always preserved.
 *   7. Return the session URL and a devotional summary.
 *
 * Idempotency: generateNow() checks for an existing devotional for the
 * requested date at the start and returns early (AlreadyExistsError) if
 * one is found — safe to call from Cloud Scheduler's daily batch.
 *
 * Bands: reads today's most recent `daily_bands` row uploaded by the iOS
 * app. If no row exists yet, a neutral/moderate default BandInput is used.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_VOICE_NAME,
  StillnessSchema,
  resolveVoiceName,
  type BandInput,
  type DevotionalFormat,
  type LanguageTag,
  type SlotType,
  type Stillness,
  type Tradition,
} from '@kairos/shared-contracts';
import { DevotionalEngine, type GenerateDevotionalResult } from '../devotionalEngine.js';
import { NO_SIGNALS_OBSERVED, type SignalProvenance } from '../gloo/instructionsBuilder.js';
import { TtsService, TtsServiceError } from '../tts/ttsService.js';
import type { AudioStorage } from '../audio/audioStorage.js';
import type { GoogleCalendarClient } from '../calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../calendar/googleKmsService.js';
import { resolveSchedulingWindow } from '../calendar/schedulingWindow.js';
import type { DeliveryProvider } from '../delivery/deliveryProvider.js';
import type { TaskScheduler } from '../tasks/taskScheduler.js';
import { HostedSessionProvider } from '../delivery/hostedSessionProvider.js';
import {
  asVerifiedUserId,
  type CalendarEventsRepository,
  type ConnectionsRepository,
  type DailyBandsRepository,
  type DevotionalRow,
  type DevotionalsRepository,
  type PrayerIntentionsRepository,
  type PreferencesRepository,
  type SessionRow,
  type SessionsRepository,
  type UsersRepository,
} from '../../db/repositories/index.js';

/** Foundation §4.3 default translation — "BSB 3034 — verified live 2026-07-02 against our app key — default." */
export const DEFAULT_TRADITION: Tradition = 'general';
export const DEFAULT_TRANSLATION = 'BSB';
export const DEFAULT_VERSION_ID = 3034;

/** Placeholder expiry — Foundation §10 / API spec §8.2 pin "event-end + 48h"; no calendar event exists in this pass. */
export const SESSION_EXPIRY_MS = 48 * 60 * 60 * 1000;

/** Minimum calendar gap (minutes) required before inserting an 'extended'-format devotional (docs/14 §5.6, issue #94) — see runCalendarStep. */
export const EXTENDED_FORMAT_MIN_GAP_MINUTES = 15;

/**
 * Neutral fallback bands used ONLY when the user has no `daily_bands` row
 * for today yet (e.g. has never opened the iOS app / granted HealthKit).
 */
export const NEUTRAL_DEFAULT_BANDS: BandInput = {
  recovery: 'moderate',
  sleepQuality: 'fair',
  activity: 'moderate',
  busyness: 'moderate',
  communicationLoad: null,
  distressSignal: false,
};

/**
 * Thrown by generateNow() when a devotional already exists for the
 * requested date — allows callers (e.g. trigger-daily-run) to distinguish
 * idempotent skips from real errors.
 */
export class AlreadyExistsError extends Error {
  constructor(
    public readonly devotionalId: string,
    public readonly sessionToken: string,
    public readonly sessionUrl: string,
  ) {
    super(`Devotional already exists for this date (id=${devotionalId})`);
    this.name = 'AlreadyExistsError';
  }
}

export interface GenerateNowLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: GenerateNowLogger = {
  error: (msg, meta) => console.error(`[generateNowOrchestrator] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[generateNowOrchestrator] ${msg}`, meta ?? ''),
};

export interface GenerateNowOrchestratorDeps {
  users: UsersRepository;
  preferences: PreferencesRepository;
  dailyBands: DailyBandsRepository;
  devotionals: DevotionalsRepository;
  sessions: SessionsRepository;
  devotionalEngine: DevotionalEngine;
  ttsService: TtsService;
  audioStorage: AudioStorage;
  /** e.g. "https://kairos.app" or "http://localhost:8080" — no trailing slash. */
  publicBaseUrl: string;
  /** Injectable clock for deterministic expiry in tests. */
  now?: () => Date;
  logger?: GenerateNowLogger;
  /** Optional calendar dependencies — when omitted, Step 6 is skipped entirely. */
  calendarClient?: GoogleCalendarClient;
  connections?: ConnectionsRepository;
  kmsService?: GoogleKmsService;
  calendarEvents?: CalendarEventsRepository;
  /** Optional (docs/14 §5.5, issue #93): when wired, generateNow() looks up yesterday's recorded prayer intention and weaves it into today's instructions. Omitted, behavior is unchanged (no line). */
  prayerIntentions?: PrayerIntentionsRepository;
  /**
   * How the session's join link is delivered (D4/#32, docs/22 §2.1).
   * Defaults to `HostedSessionProvider` — omitting this is byte-identical
   * to the pre-DeliveryProvider behavior (the only behavior this codebase
   * has ever run in production).
   */
  deliveryProvider?: DeliveryProvider;
  /**
   * H1c (#131): when `deliveryProvider.kind === 'meetbot'` AND this is
   * present, Step 6 requests a real Meet link (`conferenceData`) and
   * schedules a Cloud Tasks job to dispatch an Attendee bot at
   * `gap_start_at`. Omitted, MeetBotProvider behaves identically to
   * HostedSessionProvider (plain conferenceData-free event, no dispatch)
   * — this is the seam issue #131 flagged as needing explicit owner
   * confirmation before the first live Cloud Tasks job, so it stays
   * fully opt-in rather than activating just because MeetBotProvider is
   * wired.
   */
  meetBotDispatch?: {
    taskScheduler: TaskScheduler;
    /** Full URL to `POST /internal/dispatch-meetbot`, e.g. `${publicBaseUrl}/internal/dispatch-meetbot`. */
    dispatchUrl: string;
    /** Sent as the `X-Internal-Token` header on the scheduled task — same shared secret routes/internal.ts checks. */
    internalApiToken: string;
  };
}

export interface GenerateNowParams {
  userId: string;
  /** ISO date (YYYY-MM-DD) to load today's bands for. Defaults to the injected clock's date (UTC). */
  date?: string;
  /** Override bands directly (tests / callers that already have bands in hand). Skips the daily_bands lookup entirely when provided. */
  bandsOverride?: BandInput;
  /** Override tradition/translation/preferredVersionId/stillness directly, bypassing the preferences lookup. */
  preferencesOverride?: {
    tradition: Tradition;
    translation: string;
    preferredVersionId: number;
    stillness?: Stillness;
    lectio?: boolean;
    liturgicalSeasonsEnabled?: boolean;
  };
  /** Skip calendar integration for this invocation (e.g. tests, manual runs that don't want a calendar event). */
  skipCalendar?: boolean;
  /**
   * The user's own words from an event they invited Wellspring to (Epic I / I2,
   * #62) — deliberate disclosure woven into the devotional with elevated
   * care (see DevotionalEngine/instructionsBuilder). Omitted → no line.
   */
  inviteContext?: string;
  /**
   * Overrides the target format for this generation (Epic I / I2): an
   * invite carries its own duration, so the devotional fits the meeting the
   * user actually booked. Takes precedence over the sabbath/auto default.
   */
  durationPreferenceOverride?: DevotionalFormat;
  /**
   * Which devotional slot to generate — defaults to 'standard' (the
   * ordinary morning devotional). 'examen' is the evening reflection
   * (docs/14 §5.3, issue #77): keyed separately in the idempotency check
   * so a same-day examen never collides with that day's standard
   * devotional, and never triggers Step 6's "tomorrow's window" calendar
   * insertion, which is a morning-slot-only concept.
   */
  slotType?: SlotType;
  /**
   * Forces `bands.distressSignal = true` for this single generation
   * (docs/14 §5.8, issue #77) without discarding the user's real
   * recovery/sleep/activity/busyness bands the way a full `bandsOverride`
   * would — used by the "I could use a moment now" distress check-in,
   * which fires immediately on a real signal snapshot, not a synthetic one.
   */
  distressSignalOverride?: boolean;
  /**
   * Bypasses the "already generated for this date+slot" guard entirely.
   * That guard exists so Cloud Scheduler reruns of the batch jobs are
   * safe no-ops — it is not meant to block a manual, user-initiated
   * request for immediate comfort (the distress check-in) from ever
   * producing a fresh session, even if today's standard devotional
   * already exists.
   */
  skipIdempotencyCheck?: boolean;
  /**
   * Sabbath awareness (docs/14 §5.6, issue #94): when true, pins
   * `durationPreference` to 'extended' for this single generation
   * (regardless of bands) and forces the created devotional row's
   * `actionStep` to null, even if the model returned one — a rest day is
   * deliberately not framed as another task. `slotType` intentionally
   * stays 'standard' (the daily-run gate, not the orchestrator, decides
   * whether today is this user's sabbath), so idempotency keying and the
   * calendar-skip condition are unaffected by this flag.
   */
  sabbathSession?: boolean;
}

export type GenerateNowAudioOutcome =
  | { status: 'uploaded'; objectKey: string }
  | { status: 'unavailable'; reason: string };

export type GenerateNowCalendarOutcome =
  | { eventId: string; gapStartAt: Date; gapEndAt: Date }
  | { skipped: string };

export interface GenerateNowResult {
  sessionUrl: string;
  sessionToken: string;
  devotionalId: string;
  devotional: {
    format: string;
    theme: string;
    cardSummary: string;
  };
  source: GenerateDevotionalResult['source'];
  audio: GenerateNowAudioOutcome;
  calendar?: GenerateNowCalendarOutcome;
}

function todayIsoDate(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

/** One calendar day before `date` (YYYY-MM-DD) — pure string/Date math off the already-resolved generation date, no clock read (docs/14 §5.5, issue #93). */
function previousIsoDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Chains DevotionalEngine -> TtsService -> AudioStorage -> devotional row ->
 * session row -> calendar event for one user.
 */
export class GenerateNowOrchestrator {
  private readonly users: UsersRepository;
  private readonly preferences: PreferencesRepository;
  private readonly dailyBands: DailyBandsRepository;
  private readonly devotionals: DevotionalsRepository;
  private readonly sessions: SessionsRepository;
  private readonly devotionalEngine: DevotionalEngine;
  private readonly ttsService: TtsService;
  private readonly audioStorage: AudioStorage;
  private readonly publicBaseUrl: string;
  private readonly now: () => Date;
  private readonly logger: GenerateNowLogger;
  private readonly calendarClient?: GoogleCalendarClient;
  private readonly connections?: ConnectionsRepository;
  private readonly kmsService?: GoogleKmsService;
  private readonly calendarEvents?: CalendarEventsRepository;
  private readonly prayerIntentions?: PrayerIntentionsRepository;
  private readonly deliveryProvider: DeliveryProvider;
  private readonly meetBotDispatch?: GenerateNowOrchestratorDeps['meetBotDispatch'];

  constructor(deps: GenerateNowOrchestratorDeps) {
    this.users = deps.users;
    this.preferences = deps.preferences;
    this.dailyBands = deps.dailyBands;
    this.devotionals = deps.devotionals;
    this.sessions = deps.sessions;
    this.devotionalEngine = deps.devotionalEngine;
    this.ttsService = deps.ttsService;
    this.audioStorage = deps.audioStorage;
    this.publicBaseUrl = deps.publicBaseUrl.replace(/\/+$/, '');
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? consoleLogger;
    this.calendarClient = deps.calendarClient;
    this.connections = deps.connections;
    this.kmsService = deps.kmsService;
    this.calendarEvents = deps.calendarEvents;
    this.prayerIntentions = deps.prayerIntentions;
    this.deliveryProvider = deps.deliveryProvider ?? new HostedSessionProvider(this.publicBaseUrl);
    this.meetBotDispatch = deps.meetBotDispatch;
  }

  /**
   * Loads tradition/translation/preferredVersionId for a user. Falls back
   * to general/BSB/3034 (docs/14 §3.5's "return defaults instead of 404")
   * rather than requiring a preferences row to already exist.
   */
  private async loadPreferences(userId: string): Promise<{
    tradition: Tradition;
    translation: string;
    preferredVersionId: number;
    language: LanguageTag;
    stillness: Stillness;
    lectio: boolean;
    liturgicalSeasonsEnabled: boolean;
    durationPreference: DevotionalFormat | undefined;
    voiceName: string;
    calendarEnabled: boolean;
    healthEnabled: boolean;
    communicationEnabled: boolean;
  }> {
    const verifiedUserId = asVerifiedUserId(userId);
    const user = await this.users.findById(verifiedUserId);
    const prefsRow = await this.preferences.get(verifiedUserId);

    const tradition = user?.tradition ?? DEFAULT_TRADITION;
    const preferredVersionId = user?.translation_id ?? DEFAULT_VERSION_ID;
    const translation = versionIdToLabel(preferredVersionId);
    // `language` is a users-table column with a NOT NULL 'en' default and a
    // write path that validates against the LanguageTag enum (#314), so no
    // re-validation here — the `??` covers only the no-user-row case, same
    // as tradition/translation above. Consumed by the TTS step (O4 #316):
    // the voice locale and the spoken connective phrases follow it.
    const language = user?.language ?? DEFAULT_LANGUAGE;
    // `stillness` is a plain `text` column (see shared-contracts'
    // PreferencesResponseDataSchema comment) — an unrecognized value
    // stored out-of-band would otherwise silently fall through to Cloud
    // TTS as "no stillness", so validate against the schema here too.
    const stillness = StillnessSchema.safeParse(prefsRow?.stillness).data ?? 'off';
    // `lectio`/`liturgical_seasons_enabled` are real Postgres `boolean`
    // columns (migrations 1720950000000, 1721100000000), so the DB type
    // itself is authoritative — no Zod re-validation needed the way
    // `stillness`'s free-text column requires.
    const lectio = prefsRow?.lectio ?? false;
    const liturgicalSeasonsEnabled = prefsRow?.liturgical_seasons_enabled ?? false;

    // `duration_preference` is a real `devotional_format` enum column, so
    // (like lectio above, unlike stillness) the DB type is authoritative and
    // needs no Zod re-validation. NULL means "auto" (migration
    // 1721500000000) and is mapped to `undefined` here so it falls through
    // to `resolveTargetFormat`'s band heuristic — that is what auto *is*.
    // Missing row behaves the same way. Issue #202.
    const durationPreference = prefsRow?.duration_preference ?? undefined;

    // Granular consent (Foundation §8, issue #201). Real Postgres `boolean`
    // columns, so — like `lectio` above — the DB type is authoritative and
    // no Zod re-validation is needed.
    //
    // The `?? true` fallback is for the **no-preferences-row-at-all** case
    // only (`loadPreferences` deliberately does not require a row to exist;
    // see the "return defaults instead of 404" note above). A user with no
    // row has never been offered these toggles, so treating the absent row
    // as a revocation would suppress signals they *did* consent to through
    // the upstream gates that actually gate collection — the `connections`
    // row for calendar, the device-local `ConsentStore` + HealthKit grant
    // for health. Those gates are unchanged and still upstream of this one:
    // if the user never consented there, there is no signal here to
    // suppress in the first place. Matches the column default set by
    // migration 1721700000000, which explains the reasoning at length.
    const calendarEnabled = prefsRow?.calendar_enabled ?? true;
    const healthEnabled = prefsRow?.health_enabled ?? true;
    const communicationEnabled = prefsRow?.communication_enabled ?? true;

    // `voice` is a plain `text` column with no DB-level constraint, and the
    // iOS picker stores semantic labels (`warm`) rather than voice ids, so
    // it MUST be resolved against the catalog before it can reach Cloud TTS
    // — an unrecognized name would otherwise be rejected upstream and cost
    // the user their audio entirely. Falling back to the deployment default
    // keeps generation alive (#202 acceptance), but is logged, because
    // "your voice choice was ignored" is exactly the class of silent
    // failure #193 exists to stop.
    const resolvedVoice = resolveVoiceName(prefsRow?.voice);
    if (prefsRow?.voice && resolvedVoice === null) {
      // `info`, not `error`: GenerateNowLogger has no `warn`, and this is the
      // same class of event as "No preferences row — using defaults" below
      // (a default was substituted, nothing broke) rather than the
      // failure-shaped events `error` is used for.
      this.logger.info('Unrecognized stored voice — falling back to default', {
        userId,
        storedVoice: prefsRow.voice,
        fallbackVoice: DEFAULT_VOICE_NAME,
      });
    }
    const voiceName = resolvedVoice ?? DEFAULT_VOICE_NAME;

    if (!prefsRow) {
      this.logger.info('No preferences row for user — using defaults', {
        userId,
        tradition,
        translation,
        preferredVersionId,
      });
    }

    return {
      tradition,
      translation,
      preferredVersionId,
      language,
      stillness,
      lectio,
      liturgicalSeasonsEnabled,
      durationPreference,
      voiceName,
      calendarEnabled,
      healthEnabled,
      communicationEnabled,
    };
  }

  /**
   * Loads today's bands, falling back to a neutral default when no row exists
   * yet — and reports WHICH of the returned values were actually measured
   * (issue #196 / K10).
   *
   * This method is the only place in the system that knows the difference. The
   * `daily_bands` columns are nullable precisely because a user may grant some
   * signals and not others (Foundation §149: each category is "an independent,
   * revocable opt-in"), but the `??` coalescing below erases that distinction
   * on the way out — a null recovery column and a measured `moderate` recovery
   * become the same `'moderate'` string. Returning `provenance` alongside
   * preserves the fact for `buildInstructions`, which needs it to avoid
   * narrating a fallback constant as an observation.
   *
   * ## Consent gating (issue #201, Foundation §8)
   *
   * `consent` suppresses signals **at read time**, which is the whole point
   * of #201: rows may already exist from before the user revoked, and the
   * user's "off" means "don't use this", not merely "don't collect more of
   * it". Suppression happens here rather than at the call sites so there is
   * exactly one place a disabled signal can leak from.
   *
   * A suppressed signal is forced to its neutral default **and** marked NOT
   * OBSERVED in the returned provenance. Both halves are load-bearing, and
   * the provenance half is the #196 interaction:
   * `instructionsBuilder.describeBandContext` only narrates a band the
   * provenance vouches for, and `signalHonestyInstruction` tells the model
   * outright not to speak to unobserved signals. Zeroing the value without
   * clearing provenance would hand Gloo a fabricated `moderate` stamped as
   * measured, and the devotional would narrate a health observation to a
   * user who just revoked health access — a worse privacy outcome than the
   * dead flag #201 set out to fix.
   */
  private async loadBands(
    userId: string,
    date: string,
    consent: { calendarEnabled: boolean; healthEnabled: boolean; communicationEnabled: boolean },
  ): Promise<{ bands: BandInput; provenance: SignalProvenance }> {
    const verifiedUserId = asVerifiedUserId(userId);
    const row = await this.dailyBands.getForDate(verifiedUserId, date);
    if (!row) {
      this.logger.info('No daily_bands row for today — using neutral defaults', { userId, date });
      return { bands: NEUTRAL_DEFAULT_BANDS, provenance: NO_SIGNALS_OBSERVED };
    }

    // `health_enabled` covers exactly the three HealthKit-derived bands
    // (docs/04 §3's consent table splits health into recovery/sleep/activity;
    // this column is the coarser server-side switch over all three).
    // `busyness` is calendar-derived, so it answers to `calendar_enabled`
    // instead — a user who revokes health but keeps their calendar connected
    // stays a genuine calendar-first user (docs/03 §10's "calendar-only"
    // case), which the pivot in #197 makes the common shape.
    const { healthEnabled, calendarEnabled, communicationEnabled } = consent;
    if (!healthEnabled || !calendarEnabled || !communicationEnabled) {
      this.logger.info('Consent gate suppressing signals for this generation', {
        userId,
        date,
        healthEnabled,
        calendarEnabled,
        communicationEnabled,
      });
    }

    const recovery = healthEnabled ? row.recovery : null;
    const sleepQuality = healthEnabled ? row.sleep_quality : null;
    const activity = healthEnabled ? row.activity : null;
    const busyness = calendarEnabled ? row.busyness : null;

    return {
      bands: {
        recovery: recovery ?? NEUTRAL_DEFAULT_BANDS.recovery,
        sleepQuality: sleepQuality ?? NEUTRAL_DEFAULT_BANDS.sleepQuality,
        activity: activity ?? NEUTRAL_DEFAULT_BANDS.activity,
        busyness: busyness ?? NEUTRAL_DEFAULT_BANDS.busyness,
        // `communicationLoad` is already `null`-as-absent (it has no
        // provenance flag of its own — see describeBandContext's note that
        // null is self-describing here), so revocation is just forcing null.
        communicationLoad: communicationEnabled ? (row.communication_load ?? null) : null,
        // `distressSignal` is deliberately NOT gated. It is not a
        // personalization signal drawn from a consented category — it is the
        // safety path (Foundation §9), and it only ever becomes true from an
        // explicit user action (the distress check-in). Suppressing it would
        // mean a consent toggle silently disabling a safety guardrail.
        distressSignal: row.distress_signal,
      },
      // A non-null column is a value something actually derived and uploaded:
      // recovery/sleepQuality/activity from on-device HealthKit derivation,
      // busyness from BusynessAnalyzer's free/busy read. Null means the signal
      // was never measured — not that it measured as average. This is what
      // makes the common calendar-first case (health absent, busyness real)
      // representable, so a calendar-only user keeps genuine busyness-driven
      // personalization instead of being flattened to "no signals at all".
      //
      // These read the consent-filtered locals above, not `row` directly
      // (#201): a revoked category must be indistinguishable from one that
      // was never measured, so the devotional cannot narrate it. See the
      // method doc comment for why both halves are required.
      provenance: {
        recovery: recovery != null,
        sleepQuality: sleepQuality != null,
        activity: activity != null,
        busyness: busyness != null,
      },
    };
  }

  async generateNow(params: GenerateNowParams): Promise<GenerateNowResult> {
    const { userId } = params;
    const date = params.date ?? todayIsoDate(this.now);
    const verifiedUserId = asVerifiedUserId(userId);
    const slotType: SlotType = params.slotType ?? 'standard';

    // Idempotency guard: if a devotional already exists for this date AND
    // slot, return early so Cloud Scheduler reruns (or duplicate calls) are
    // safe. Slot-scoped so a same-day examen never collides with that
    // day's standard devotional (issue #77). Skippable for the manual
    // distress check-in path, which must always produce a fresh session.
    const existingToday = params.skipIdempotencyCheck
      ? null
      : await this.devotionals.getForDate(verifiedUserId, date, slotType);
    if (existingToday) {
      this.logger.info('Devotional already exists for today — skipping', {
        userId,
        date,
        devotionalId: existingToday.id,
      });
      // Find the most recent session for this devotional so we can return a URL.
      // If somehow no session exists (shouldn't happen in normal flow), use a
      // placeholder token — the devotional row is still the canonical signal.
      const existingSessions = await this.sessions.listForUser(verifiedUserId);
      const existingSession = existingSessions.find((s) => s.devotional_id === existingToday.id);
      const sessionToken = existingSession?.token ?? '';
      const sessionUrl = sessionToken ? `${this.publicBaseUrl}/session/${sessionToken}` : '';
      throw new AlreadyExistsError(existingToday.id, sessionToken, sessionUrl);
    }

    const {
      tradition,
      translation,
      preferredVersionId,
      language,
      stillness,
      lectio,
      liturgicalSeasonsEnabled,
      durationPreference: storedDurationPreference,
      voiceName,
      calendarEnabled,
      healthEnabled,
      communicationEnabled,
    } = params.preferencesOverride
      ? {
          stillness: 'off' as Stillness,
          lectio: false,
          liturgicalSeasonsEnabled: false,
          // A `preferencesOverride` caller bypasses the preferences row, so
          // there is no stored consent to honor. `true` is right here rather
          // than a fail-safe `false` because these callers (invite-triggered
          // and team devotionals, tests) supply their own bands wholesale via
          // `bandsOverride` — which is already treated as NO_SIGNALS_OBSERVED
          // just below — so there is no `daily_bands` read for a consent flag
          // to protect. The override paths that do touch the calendar still
          // pass through the `connections` row, which is the real grant.
          calendarEnabled: true,
          healthEnabled: true,
          communicationEnabled: true,
          // A caller supplying `preferencesOverride` is bypassing the
          // preferences row wholesale, so there is no stored duration to
          // honor — undefined lands on the band heuristic, and the voice
          // on the deployment default.
          durationPreference: undefined as DevotionalFormat | undefined,
          voiceName: DEFAULT_VOICE_NAME,
          // Same reasoning as the voice above: no preferences row was read,
          // so the TTS language lands on the default ('en' — O4 #316).
          language: DEFAULT_LANGUAGE,
          ...params.preferencesOverride,
        }
      : await this.loadPreferences(userId);
    // `bandsOverride` arrives as a bare BandInput with no provenance attached,
    // and its callers are exactly the paths that generate from neutral bands
    // by design (invite-triggered devotionals in index.ts, team devotionals) or
    // that hand-build bands in tests. Treating those as unobserved is both
    // accurate for the production callers and the fail-safe reading for any
    // other: an override cannot vouch for measurement it never made (#196).
    const loaded = params.bandsOverride
      ? { bands: params.bandsOverride, provenance: NO_SIGNALS_OBSERVED }
      : await this.loadBands(userId, date, {
          calendarEnabled,
          healthEnabled,
          communicationEnabled,
        });
    const signalProvenance = loaded.provenance;
    const bands = params.distressSignalOverride
      ? { ...loaded.bands, distressSignal: true }
      : loaded.bands;

    this.logger.info('Starting generate-now', { userId, date, tradition, translation, slotType });

    // Deliberate disclosure (docs/14 §5.5, issue #93): weave in whatever
    // the user shared on yesterday's session-completion page, if anything.
    // Best-effort — a lookup failure here must never block generation.
    let prayerIntention: string | undefined;
    if (this.prayerIntentions) {
      try {
        const row = await this.prayerIntentions.getForDate(verifiedUserId, previousIsoDate(date));
        prayerIntention = row?.text;
      } catch (err) {
        this.logger.error('Prayer intention lookup failed — continuing without it', {
          userId,
          date,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 1: DevotionalEngine — never throws for the "provider had a bad
    // day" case (falls back to fixture internally).
    // Duration precedence (issue #202). First match wins:
    //
    //   1. invite-derived override  — this generation exists to fill a
    //      specific calendar hole, and the hole has a literal length
    //      (inviteContext.ts's durationToFormat). A 5-minute gap cannot hold
    //      a 15-minute devotional no matter what the user prefers, so the
    //      concrete constraint outranks the standing one.
    //   2. sabbath session          — an explicit, per-day opt-in
    //      (docs/14 §5.6, issue #94) for a longer contemplative session in
    //      place of the usual devotional. Also a deliberate choice, but a
    //      standing one, so it yields to the invite's hard constraint above.
    //   3. stored user preference   — the standing "always give me N min"
    //      from docs/05 §5. Outranks the heuristic because it is the one
    //      signal the user stated in words rather than one we inferred.
    //   4. undefined -> band heuristic ("auto") — resolveTargetFormat picks
    //      from recovery/busyness. Reached when the user chose auto, which
    //      is stored as NULL (migration 1721500000000) and normalized to
    //      undefined in loadPreferences.
    //
    // Note this whole ladder sits BELOW two floors already enforced inside
    // resolveTargetFormat and deliberately not duplicated here: a distress
    // signal always forces `micro` (safety, cannot be overridden by anyone),
    // and slotType='examen' is always micro/short because the examen is a
    // brief evening reflection by design — the user's duration preference
    // governs the morning devotional's length, not the examen's.
    const durationPreference: DevotionalFormat | undefined =
      params.durationPreferenceOverride ??
      (params.sabbathSession ? 'extended' : undefined) ??
      storedDurationPreference;
    const genResult = await this.devotionalEngine.generate({
      bands,
      signalProvenance,
      tradition,
      translation,
      preferredVersionId,
      slotType,
      lectio,
      durationPreference,
      date,
      liturgicalSeasonsEnabled,
      prayerIntention,
      inviteContext: params.inviteContext,
    });
    const { devotional, source } = genResult;

    // Step 2: create the devotional row FIRST — once we have a validated
    // DevotionalOutput, its text must never be silently lost.
    const devotionalRow = await this.devotionals.create(verifiedUserId, {
      date,
      format: devotional.format,
      theme: devotional.theme,
      verses: devotional.verses,
      devotionalBody: devotional.devotionalBody,
      cardSummary: devotional.cardSummary,
      prayer: devotional.prayer,
      journalingPrompt: devotional.journalingPrompt ?? null,
      actionStep: params.sabbathSession ? null : (devotional.actionStep ?? null),
      isFixtureFallback: source === 'fixture',
      status: 'ready',
      slotType,
    });

    // Step 3+4: TTS + upload — best-effort. Any failure degrades to
    // audio-unavailable path; must never take down the whole request.
    let audio: GenerateNowAudioOutcome;
    try {
      // `voiceName` is already catalog-validated by loadPreferences (#202) —
      // TtsService validates again on its own account, since it is a public
      // entry point other callers reach directly. `language` (O4 #316) makes
      // the synthesis speak the user's content language: TtsService derives
      // the locale (zh -> cmn-CN) and re-homes the voice name from it.
      const synthesized = await this.ttsService.synthesize(
        devotional,
        stillness,
        lectio,
        voiceName,
        language,
      );
      const stored = await this.audioStorage.upload(devotionalRow.id, synthesized.audio);
      await this.devotionals.setAudioObject(verifiedUserId, devotionalRow.id, stored.objectKey);
      audio = { status: 'uploaded', objectKey: stored.objectKey };
      this.logger.info('TTS + upload succeeded', {
        userId,
        devotionalId: devotionalRow.id,
        segmentCount: synthesized.segmentCount,
      });
    } catch (err) {
      const reason =
        err instanceof TtsServiceError
          ? err.message
          : `Unexpected audio pipeline failure: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error('TTS/upload failed — continuing with audio-unavailable session', {
        userId,
        devotionalId: devotionalRow.id,
        reason,
      });
      audio = { status: 'unavailable', reason };
    }

    // Step 5: session row. Placeholder expiry (now + 48h) — may be
    // updated in Step 6 to event-end + 48h after calendar insertion.
    const expiresAt = new Date(this.now().getTime() + SESSION_EXPIRY_MS);
    const sessionRow = await this.sessions.create(verifiedUserId, {
      devotionalId: devotionalRow.id,
      expiresAt,
    });

    // DeliveryProvider (D4/#32, docs/22 §2.1): `sessionUrl` stays the plain
    // session page for every downstream consumer (iOS result, existing
    // tests) — `fallbackUrl` is byte-identical to it for the default
    // HostedSessionProvider. `joinUrl` differs only when a richer provider
    // (e.g. LiveKit) is wired, and is used solely in the calendar
    // description's primary link, below.
    const delivery = this.deliveryProvider.prepareDelivery({ sessionToken: sessionRow.token });
    const sessionUrl = delivery.fallbackUrl;
    const joinUrl = delivery.joinUrl;

    // Step 6: Calendar integration (if all deps are present and not skipped).
    // Auto-skipped for any non-'standard' slot (e.g. examen) and for the
    // distress check-in: "insert tomorrow's window" is a morning-slot-only
    // concept, and would otherwise insert a bogus duplicate event.
    const skipCalendar = params.skipCalendar || slotType !== 'standard' || params.distressSignalOverride === true;
    let calendarOutcome: GenerateNowCalendarOutcome | undefined;
    if (!calendarEnabled && !skipCalendar) {
      // Consent gate (issue #201, Foundation §8). Deliberately placed ABOVE
      // the dependency check so revocation is reported as its own outcome
      // (`consent_revoked`) rather than silently sharing the "no calendar
      // configured" path — a privacy decision the user made should be
      // legible in the result and the logs, not inferred from an absence.
      //
      // Returning before `runCalendarStep` is what makes this a real gate:
      // that method is where both privileged calendar operations live — the
      // freeBusy read and the insertEvent write — so neither can happen.
      // Gating here rather than inside it also means the OAuth token is
      // never decrypted (`kmsService`), so a revoked user's credential is
      // not even unwrapped in memory.
      this.logger.info('calendar_enabled is false — skipping calendar step entirely', {
        userId,
        date,
      });
      calendarOutcome = { skipped: 'consent_revoked' };
    } else if (
      this.calendarClient &&
      this.connections &&
      this.kmsService &&
      this.calendarEvents &&
      !skipCalendar
    ) {
      calendarOutcome = await this.runCalendarStep({
        userId,
        verifiedUserId,
        devotionalRow,
        sessionRow,
        sessionUrl,
        joinUrl,
        devotional,
        date,
      });
    }

    this.logger.info('generate-now complete', {
      userId,
      devotionalId: devotionalRow.id,
      sessionToken: sessionRow.token,
      source,
      audioStatus: audio.status,
    });

    return {
      sessionUrl,
      sessionToken: sessionRow.token,
      devotionalId: devotionalRow.id,
      devotional: {
        format: devotional.format,
        theme: devotional.theme,
        cardSummary: devotional.cardSummary,
      },
      source,
      audio,
      ...(calendarOutcome !== undefined ? { calendar: calendarOutcome } : {}),
    };
  }

  /**
   * Calendar integration step (Step 6). Wrapped separately so the catch
   * block is clean and any calendar failure clearly doesn't affect the
   * devotional/session result.
   *
   * Privacy (Foundation §8): we only call freeBusy (busy-time windows, no
   * content) and insertEvent (writing our own event). We never read or
   * persist other event data.
   */
  private async runCalendarStep(params: {
    userId: string;
    verifiedUserId: ReturnType<typeof asVerifiedUserId>;
    devotionalRow: DevotionalRow;
    sessionRow: SessionRow;
    sessionUrl: string;
    /** D4/#32: the delivery provider's primary join link — equal to `sessionUrl` unless a richer provider (e.g. LiveKit) is wired. */
    joinUrl: string;
    devotional: import('../devotionalEngine.js').GenerateDevotionalResult['devotional'];
    date: string;
  }): Promise<GenerateNowCalendarOutcome> {
    const { userId, verifiedUserId, devotionalRow, sessionRow, sessionUrl, joinUrl, devotional } = params;

    try {
      // 6a. Load the user's Google Calendar connection.
      const connection = await this.connections!.findByProvider(verifiedUserId, 'google_calendar');
      if (!connection || connection.status !== 'active') {
        this.logger.info('No active Google Calendar connection — skipping calendar step', { userId });
        return { skipped: 'no_active_connection' };
      }

      // 6b. Decrypt the refresh token.
      const refreshToken = await this.kmsService!.decryptToken(connection.encrypted_refresh_token);

      // 6c. Build a per-request calendar client with this user's token.
      const userCalendarClient = this.calendarClient!.withRefreshToken(refreshToken);

      // 6d. Load user preferences for timezone and window.
      const user = await this.users.findById(verifiedUserId);
      const prefs = await this.preferences.get(verifiedUserId);
      // Timezone from users.timezone (set at signup, defaults to 'UTC').
      const tz = user?.timezone ?? 'UTC';

      // 6e. Call freeBusy for tomorrow's scheduling window.
      // "Tomorrow" relative to today's date param (the date we're generating FOR).
      const baseDate = new Date(params.date + 'T00:00:00Z');
      baseDate.setUTCDate(baseDate.getUTCDate() + 1);
      const tomorrowStr = baseDate.toISOString().slice(0, 10);

      const windowStart = prefs?.window_start_local ?? '09:00:00';
      const windowEnd = prefs?.window_end_local ?? '17:00:00';

      // Resolve the wall-clock preference window into absolute instants **in
      // the user's zone** (#205). This used to be `setUTCHours(...)`, which
      // read `07:00:00` as 07:00 UTC for every user and produced the 3:30am
      // devotional; see schedulingWindow.ts for the full rationale and the
      // DST policy. `tomorrowStr` is a date *label*, and is now interpreted in
      // `tz` rather than in UTC.
      const windowBounds = resolveSchedulingWindow({
        date: tomorrowStr,
        windowStartLocal: windowStart,
        windowEndLocal: windowEnd,
        timeZone: tz,
      });

      if (windowBounds.zoneFallback) {
        // GenerateNowLogger deliberately exposes only info/error (no warn).
        this.logger.error('Unsupported user timezone — scheduling window resolved in UTC', {
          userId,
          timezone: tz,
        });
      }

      // A spring-forward gap can erase the requested window entirely. There is
      // nothing to search, and an inverted range is a 400 from freeBusy, so
      // skip before calling out rather than failing the whole devotional.
      if (windowBounds.degenerate) {
        this.logger.info('Scheduling window does not exist on this date (DST transition) — skipping calendar event', {
          userId,
          date: tomorrowStr,
          timezone: windowBounds.timeZone,
          windowStart,
          windowEnd,
        });
        return { skipped: 'dst_degenerate_window' };
      }

      const { timeMin, timeMax } = windowBounds;

      // Every downstream call uses `windowBounds.timeZone`, not the raw `tz`: it is
      // the zone the bounds were actually computed in, so busy-block
      // interpretation and event placement can never disagree with the window
      // (and an unsupported `tz` degrades to UTC once, here, rather than
      // erroring separately at each Google call).
      const busyBlocks = await userCalendarClient.getFreeBusyBlocks({
        timeMin,
        timeMax,
        timeZone: windowBounds.timeZone,
      });

      // 6f. Find best gap using BusynessAnalyzer (standalone function export).
      const { analyzeBusyness } = await import('../busynessAnalyzer.js');
      const analysis = analyzeBusyness(
        { start: timeMin, end: timeMax, timeZone: windowBounds.timeZone },
        busyBlocks.map((b) => ({ start: b.start, end: b.end })),
      );

      // Gaps are sorted longest-first (busynessAnalyzer.ts), so checking only
      // the largest against the floor is equivalent to checking all of them.
      // An 'extended' (~15+ min) session — natural via bands or forced by
      // sabbathSession (docs/14 §5.6, issue #94) — stuffed into a 2-minute
      // gap would just get cut off; shorter formats have no such floor.
      const requiredMinutes = devotional.format === 'extended' ? EXTENDED_FORMAT_MIN_GAP_MINUTES : 0;
      const bestGap = analysis.gaps[0];
      if (!bestGap || bestGap.durationMinutes < requiredMinutes) {
        this.logger.info('No suitable gap found — skipping calendar event', {
          userId,
          busyness: analysis.busyness,
          requiredMinutes,
        });
        return { skipped: 'no_gap_found' };
      }

      // 6g. Insert the calendar event. When the delivery provider's joinUrl
      // differs from the plain session page (D4/#32 — e.g. LiveKit), the
      // richer link goes first and the session page stays as an explicit,
      // always-present fallback line (DEC-K3) rather than disappearing.
      const eventDescription = [
        devotional.cardSummary,
        '',
        'Join your devotional: ' + joinUrl,
        ...(joinUrl !== sessionUrl ? ['Prefer plain audio? ' + sessionUrl] : []),
        '',
        devotional.verses.map((v) => v.attribution).join('; '),
      ].join('\n');

      // H1c (#131): MeetBotProvider requests a real Meet link. Google
      // Calendar renders conferenceData as its own distinct "Join with
      // Google Meet" UI element — separate from the text description —
      // so no description changes are needed here regardless of which
      // delivery provider is active.
      const useMeetBot = this.deliveryProvider.kind === 'meetbot';

      const inserted = await userCalendarClient.insertEvent({
        summary: 'Wellspring — a moment with God',
        description: eventDescription,
        startDateTime: bestGap.start,
        endDateTime: bestGap.end,
        timeZone: windowBounds.timeZone,
        ...(useMeetBot ? { requestConferenceData: true } : {}),
      });

      // 6h. Update session expiry to event-end + 48h (Foundation §10).
      const eventEnd = new Date(bestGap.end);
      const realExpiry = new Date(eventEnd.getTime() + SESSION_EXPIRY_MS);
      await this.sessions.updateExpiry(verifiedUserId, sessionRow.token, realExpiry);

      // 6i. Store calendar event record (gap only — no titles/content, Foundation §8).
      await this.calendarEvents!.create(verifiedUserId, {
        devotionalId: devotionalRow.id,
        providerEventId: inserted.eventId,
        gapSource: 'found_gap',
        gapStartAt: new Date(bestGap.start),
        gapEndAt: new Date(bestGap.end),
        meetUri: inserted.meetUri,
      });

      this.logger.info('Calendar event inserted', {
        userId,
        eventId: inserted.eventId,
        gapStart: bestGap.start,
        meetUri: inserted.meetUri,
      });

      // H1c (#131): schedule the Attendee bot dispatch at gap_start_at.
      // Fully opt-in — requires BOTH a real meetUri (conferenceData
      // succeeded) AND this.meetBotDispatch explicitly configured (the
      // owner-confirmed Cloud Tasks queue, per issue #131). Never blocks
      // or fails the devotional/calendar event if scheduling fails.
      if (inserted.meetUri && this.meetBotDispatch) {
        try {
          await this.meetBotDispatch.taskScheduler.scheduleHttpTask({
            url: this.meetBotDispatch.dispatchUrl,
            scheduleTime: new Date(bestGap.start),
            headers: { 'X-Internal-Token': this.meetBotDispatch.internalApiToken },
            body: { meetingUrl: inserted.meetUri, devotionalId: devotionalRow.id },
            taskName: `meetbot-${devotionalRow.id}`,
          });
          this.logger.info('MeetBot dispatch scheduled', { userId, devotionalId: devotionalRow.id, gapStart: bestGap.start });
        } catch (err) {
          this.logger.error('MeetBot dispatch scheduling failed — event still created', {
            userId,
            devotionalId: devotionalRow.id,
            reason: String(err),
          });
        }
      }

      return {
        eventId: inserted.eventId,
        gapStartAt: new Date(bestGap.start),
        gapEndAt: new Date(bestGap.end),
      };
    } catch (err) {
      // Calendar failure must NEVER lose the devotional/session.
      this.logger.error('Calendar integration failed — devotional still created', {
        userId,
        reason: String(err),
      });
      return { skipped: 'calendar_error' };
    }
  }
}

/**
 * Maps a YouVersion numeric versionId to the short label DevotionalEngine's
 * prose framing expects (Foundation §4.3 table). Falls back to the numeric
 * id itself for any id not in the small known table.
 */
function versionIdToLabel(versionId: number): string {
  const known: Record<number, string> = {
    3034: 'BSB',
    12: 'ASV',
    206: 'WEBUS',
    42: 'CPDV',
    130: 'TOJB2011',
    1207: 'WMBBE',
    1209: 'WMB',
    1932: 'FBV',
    2163: 'Geneva',
    2660: 'LSV',
    3427: 'TCENT',
  };
  return known[versionId] ?? String(versionId);
}
