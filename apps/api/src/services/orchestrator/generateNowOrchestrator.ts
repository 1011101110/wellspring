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
 *      (sessionsRepository — the unguessable session token is minted by
 *      the sessions table itself on insert) with a placeholder expiry of
 *      now + 48h.
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
import {
  DEFAULT_LANGUAGE,
  DEFAULT_VOICE_NAME,
  LanguageTagSchema,
  StillnessSchema,
  defaultVersionIdFor,
  isVersionInLanguage,
  resolveVoiceName,
  versionDisplayLabel,
  type BandInput,
  type DevotionalFormat,
  type LanguageTag,
  type OpenMomentContext,
  type SlotType,
  type Stillness,
  type Tradition,
} from '@kairos/shared-contracts';
import { DevotionalEngine, type GenerateDevotionalResult } from '../devotionalEngine.js';
import {
  NO_SIGNALS_OBSERVED,
  resolveTargetFormat,
  type SignalProvenance,
} from '../gloo/instructionsBuilder.js';
import {
  NO_STEERING,
  type FeedbackSteering,
  type SteeringDecision,
} from '../rhythm/feedbackSteering.js';
import { decideHighlightWeaving } from '../youversion/highlightsBridge.js';
import type { NormalizedHighlight } from '../youversion/youVersionHighlightsClient.js';
import { resolvePreferredInstant, selectGap } from '../calendar/gapSelection.js';
import { TtsService, TtsServiceError } from '../tts/ttsService.js';
import type { AudioStorage } from '../audio/audioStorage.js';
import type { GoogleCalendarClient } from '../calendar/googleCalendarClient.js';
import type { GoogleKmsService } from '../calendar/googleKmsService.js';
import { resolveSchedulingWindow } from '../calendar/schedulingWindow.js';
import type { DeliveryProvider } from '../delivery/deliveryProvider.js';
import { buildEventBody } from '../invite/eventBody.js';
import type { TaskScheduler } from '../tasks/taskScheduler.js';
import { HostedSessionProvider } from '../delivery/hostedSessionProvider.js';
import { sessionUrlFor } from '../delivery/sessionUrls.js';
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
  type VerifiedUserId,
} from '../../db/repositories/index.js';

/**
 * Default tradition when a user row has none. The companion translation
 * default is no longer a constant here: since Epic O (#311),
 * `defaultVersionIdFor(language)` in shared-contracts is the single source
 * of the default versionId (en -> BSB 3034, Foundation §4.3).
 */
export const DEFAULT_TRADITION: Tradition = 'general';

/**
 * Session expiry horizon — Foundation §10 / API spec §8.2 pin
 * "event-end + 48h". Used first as a placeholder from `now` at session
 * creation (Step 5), then re-applied from the calendar event's end once
 * Step 6 inserts one.
 */
export const SESSION_EXPIRY_MS = 48 * 60 * 60 * 1000;

/** Minimum calendar gap (minutes) required before inserting an 'extended'-format devotional (docs/14 §5.6, issue #94) — see runCalendarStep. */
export const EXTENDED_FORMAT_MIN_GAP_MINUTES = 15;

/**
 * READ bridge (U4 #357): how far back to fetch highlights, and the no-repeat
 * window. A highlighted passage that already appears in any devotional's
 * verses within the last {@link HIGHLIGHT_NO_REPEAT_DAYS} days is not woven
 * again — the same marked verse should not recur day after day. Deriving the
 * "recently used" set from recent devotionals' verses (rather than a new
 * column) keeps the guard migration-free and self-correcting.
 */
export const HIGHLIGHT_READ_LIMIT = 20;
export const HIGHLIGHT_NO_REPEAT_DAYS = 30;

/** The narrow READ seam the orchestrator consumes — the whole HighlightsBridge satisfies it. */
export interface HighlightsReadBridge {
  readRecentHighlights(
    userId: VerifiedUserId,
    opts: { limit?: number },
  ): Promise<NormalizedHighlight[]>;
}

/** The duration bands in ascending length order — the ladder the P7 duration nudge steps along. */
export const DURATION_BANDS: readonly DevotionalFormat[] = [
  'micro',
  'short',
  'standard',
  'extended',
];

/**
 * One band shorter/longer, clamped at the ends (P7 #326): 2 of the last 3
 * feedback rows saying "shorter" moves an auto-resolved `standard` to
 * `short`, never further, and a `micro` stays `micro`. Pure and exported
 * so the golden tests can mutation-check the clamp directly.
 */
export function nudgeDuration(
  format: DevotionalFormat,
  direction: 'shorter' | 'longer',
): DevotionalFormat {
  const index = DURATION_BANDS.indexOf(format);
  const next =
    direction === 'shorter'
      ? Math.max(0, index - 1)
      : Math.min(DURATION_BANDS.length - 1, index + 1);
  return DURATION_BANDS[next]!;
}

/**
 * Resolves whether this generation actually gets an Open Moment (EPIC V #360
 * / V4 #365) from the requested flag plus the two non-negotiable safety
 * rules. Pure and exported so the golden-params tests can mutation-check the
 * distress-NEVER rule directly:
 *  - `distress` true → ALWAYS false, even when requested (a crisis moment
 *    gets comfort, never a prompt to perform aloud — epic §5 / feature #361).
 *  - otherwise → the requested flag as-is.
 *
 * The fixture-fallback rule (a fixture generation never gets an open moment —
 * it has no live engine) is enforced at the persistence site instead, since
 * whether a generation fell back to a fixture is only known AFTER the engine
 * runs; this pure function covers the two inputs known up front.
 *
 * `killSwitchEnabled` (V5 #366) is the operator kill switch — when false, the
 * window is disabled at generation time regardless of the request, so the
 * live feature ships DARK until V6. Defaults to `true` so existing callers/
 * tests that pass only (requested, distress) are unaffected; the orchestrator
 * resolves the real value from the env via `resolveOpenMomentKillSwitch`.
 */
export function resolveOpenMomentEnabled(
  requested: boolean,
  distress: boolean,
  killSwitchEnabled = true,
): boolean {
  if (!killSwitchEnabled) return false;
  if (distress) return false;
  return requested;
}

/**
 * The Open Moment kill switch (V5 #366): reads `OPEN_MOMENT_ENABLED`. The
 * feature ships DARK — the window is enabled at generation time ONLY when an
 * operator has explicitly set `OPEN_MOMENT_ENABLED=true`. Any other value
 * (unset, 'false', '0', 'yes', a typo) resolves to false. Pure over its raw
 * string input so the switch is unit-testable without mutating `process.env`.
 */
export function resolveOpenMomentKillSwitch(rawValue: string | undefined): boolean {
  return rawValue === 'true';
}

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
   * P7 (#326): feedback → generation params. Only consulted when a caller
   * also sets `GenerateNowParams.applyFeedbackSteering` (the daily run
   * does; generate-now/examen/invite/distress never do), so omitting this
   * — or the flag — is byte-identical to pre-P7 behavior.
   */
  feedbackSteering?: FeedbackSteering;
  /**
   * U4 (#357): the YouVersion READ bridge. Consulted for standard-slot
   * scheduled generations that also set `applyFeedbackSteering` (the same
   * scoping as feedback steering — generate-now/examen/invite/distress never
   * weave a highlight), and only when the read consent is on (the bridge gates
   * that internally). Omitted — or a user who has not connected / has read
   * consent off — is byte-identical to no highlight weaving. Fail-open: a
   * broken read costs the weave, never the devotional.
   */
  highlightsBridge?: HighlightsReadBridge;
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
    /**
     * Devotional content language (Epic O #311, story O3 #315). Defaults to
     * `'en'` when omitted — an override caller bypassing the preferences
     * row gets today's English behavior unless it says otherwise. A caller
     * setting this is responsible for keeping `preferredVersionId` inside
     * that language's `LANGUAGE_CATALOG` entry (the normal load path
     * enforces that pairing in `loadPreferences`).
     */
    language?: LanguageTag;
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
  /**
   * P7 (#326): apply feedback steering (theme carry-forward, duration
   * nudge, time-of-day bias) to this generation. Set ONLY by the
   * scheduled daily run — the story scopes steering to "standard-slot,
   * scheduled generation", so the user-initiated generate-now, the
   * examen, invites, and the distress check-in all leave it unset and
   * stay byte-identical to today. Requires `deps.feedbackSteering`;
   * a failure while deriving fails OPEN (unsteered generation), the
   * same posture as the daily run's adaptive-rhythm evaluation.
   */
  applyFeedbackSteering?: boolean;
  /**
   * The Open Moment (EPIC V #360 / V4 #365): request that this generation's
   * devotional open a bounded listening window after its question. Threaded
   * like `lectio` (defaults false). v1 rule: set by the meet voice-agent
   * delivery path (and, per V1, optionally the standalone floor). Two hard
   * rules are enforced downstream in `resolveOpenMomentEnabled`, NOT here:
   * a distress generation NEVER gets an open moment (a crisis moment gets
   * comfort, not a prompt to perform), and a fixture-fallback generation
   * never does (it has no live engine). Examen generations MAY (their
   * reflective structure fits).
   */
  openMomentEnabled?: boolean;
}

export type GenerateNowAudioOutcome =
  { status: 'uploaded'; objectKey: string } | { status: 'unavailable'; reason: string };

export type GenerateNowCalendarOutcome =
  { eventId: string; gapStartAt: Date; gapEndAt: Date } | { skipped: string };

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

/** `n` calendar days before `date` (YYYY-MM-DD) — the no-repeat window start for highlight weaving (U4 #357). Pure, no clock read. */
function previousIsoDateBy(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Theme precedence (P7 #326 — first present wins):
 *
 *   1. invite context        — the user's own written words for THIS
 *      meeting (I2 #62); a topical echo of last week's devotional has
 *      no business displacing them.
 *   2. prayer intention      — yesterday's deliberate disclosure
 *      (#93); same reasoning, an explicit act outranks an inference.
 *   3. feedback-steered theme — the "more on this topic" carry-forward,
 *      lowest rung: it is the only one of the three the user never
 *      typed. (Team/invite themes that call the engine directly with a
 *      `theme` param never pass through this orchestrator path at all.)
 *
 * Distinct params, one precedence rule: inviteContext and
 * prayerIntention keep flowing as their own engine params exactly as
 * before — what yields is only the steered `theme`.
 */
function resolveSteeredTheme(
  steering: SteeringDecision,
  params: GenerateNowParams,
  prayerIntention: string | undefined,
): string | undefined {
  return steering.theme !== undefined &&
    params.inviteContext === undefined &&
    prayerIntention === undefined
    ? steering.theme
    : undefined;
}

/**
 * Duration precedence (issue #202). First match wins:
 *
 *   1. invite-derived override  — this generation exists to fill a
 *      specific calendar hole, and the hole has a literal length
 *      (inviteContext.ts's durationToFormat). A 5-minute gap cannot hold
 *      a 15-minute devotional no matter what the user prefers, so the
 *      concrete constraint outranks the standing one.
 *   2. sabbath session          — an explicit, per-day opt-in
 *      (docs/14 §5.6, issue #94) for a longer contemplative session in
 *      place of the usual devotional. Also a deliberate choice, but a
 *      standing one, so it yields to the invite's hard constraint above.
 *   3. stored user preference   — the standing "always give me N min"
 *      from docs/05 §5. Outranks the heuristic because it is the one
 *      signal the user stated in words rather than one we inferred.
 *   4. undefined -> band heuristic ("auto") — resolveTargetFormat picks
 *      from recovery/busyness. Reached when the user chose auto, which
 *      is stored as NULL (migration 1721500000000) and normalized to
 *      undefined in loadPreferences.
 *   5. feedback duration nudge (P7 #326) — BELOW everything above: it
 *      applies only when every explicit source declined (i.e. the user's
 *      stored preference is 'auto'), and then nudges what the auto band
 *      heuristic would have picked by exactly one band. An explicit
 *      preference is never silently overridden (the ceiling principle).
 *      Passing the nudged band onward as `durationPreference` is safe
 *      against the floors resolveTargetFormat enforces above preferences:
 *      distress still forces 'micro' (and the distress path never steers
 *      anyway).
 *
 * Note this whole ladder sits BELOW two floors already enforced inside
 * resolveTargetFormat and deliberately not duplicated here: a distress
 * signal always forces `micro` (safety, cannot be overridden by anyone),
 * and slotType='examen' is always micro/short because the examen is a
 * brief evening reflection by design — the user's duration preference
 * governs the morning devotional's length, not the examen's.
 */
function resolveDurationPreference(
  params: GenerateNowParams,
  storedDurationPreference: DevotionalFormat | undefined,
  steering: SteeringDecision,
  bands: BandInput,
  slotType: SlotType,
): DevotionalFormat | undefined {
  const explicitDurationPreference: DevotionalFormat | undefined =
    params.durationPreferenceOverride ??
    (params.sabbathSession ? 'extended' : undefined) ??
    storedDurationPreference;
  return (
    explicitDurationPreference ??
    (steering.durationNudge !== undefined
      ? nudgeDuration(resolveTargetFormat(bands, undefined, slotType), steering.durationNudge)
      : undefined)
  );
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
  private readonly feedbackSteering?: FeedbackSteering;
  private readonly highlightsBridge?: HighlightsReadBridge;
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
    this.feedbackSteering = deps.feedbackSteering;
    this.highlightsBridge = deps.highlightsBridge;
    this.deliveryProvider = deps.deliveryProvider ?? new HostedSessionProvider(this.publicBaseUrl);
    this.meetBotDispatch = deps.meetBotDispatch;
  }

  /**
   * Loads tradition/language/translation/preferredVersionId for a user.
   * Falls back to general/en/BSB/3034 (docs/14 §3.5's "return defaults
   * instead of 404") rather than requiring a preferences row to already
   * exist.
   */
  private async loadPreferences(userId: string): Promise<{
    tradition: Tradition;
    language: LanguageTag;
    translation: string;
    preferredVersionId: number;
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
    // `language` is a plain `text` column (migration 1722300000000) — the
    // preferences route validates on write, but (like `stillness` below) an
    // out-of-band value must not flow onward unvalidated, so re-check
    // against the shared-contracts enum and fall back to 'en'.
    const language = LanguageTagSchema.safeParse(user?.language).data ?? DEFAULT_LANGUAGE;
    // Version resolution (Epic O #311, story O3 #315): the stored
    // translation wins when it belongs to the stored language's catalog;
    // anything else — no row, or a language/translation pair that got out
    // of sync despite the preferences route's cross-field rule — snaps to
    // the language's default. The check is `isVersionInLanguage`, not a
    // null-coalesce, because a stale en versionId on a user who switched to
    // 'es' would otherwise send Spanish instructions with an English Bible
    // (exactly the mixed-language devotional DEC-K12 forbids).
    const storedTranslationId = user?.translation_id;
    const preferredVersionId =
      storedTranslationId != null && isVersionInLanguage(language, storedTranslationId)
        ? storedTranslationId
        : defaultVersionIdFor(language);
    if (storedTranslationId != null && storedTranslationId !== preferredVersionId) {
      // Same class of event as the unrecognized-voice fallback below: a
      // default was substituted, nothing broke — but a silently ignored
      // stored preference must be legible in the logs (#193).
      this.logger.info(
        'Stored translation_id is not in the stored language catalog — using the language default',
        {
          userId,
          language,
          storedTranslationId,
          fallbackVersionId: preferredVersionId,
        },
      );
    }
    // Human-readable label for the model's prose framing ("Preferred Bible
    // translation: X."). `versionDisplayLabel` is the canonical
    // shared-contracts map (S1 #342 — a local copy here had drifted from it).
    const translation = versionDisplayLabel(preferredVersionId);
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
      language,
      translation,
      preferredVersionId,
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

  /**
   * Idempotency guard (phase helper): if a devotional already exists for
   * this date AND slot, bail out so Cloud Scheduler reruns (or duplicate
   * calls) are safe. Slot-scoped so a same-day examen never collides with
   * that day's standard devotional (issue #77). Skippable for the manual
   * distress check-in path, which must always produce a fresh session.
   *
   * Throws AlreadyExistsError rather than returning a sentinel so callers
   * of generateNow() (e.g. trigger-daily-run) can distinguish idempotent
   * skips from real errors.
   */
  private async ensureNotAlreadyGenerated(
    verifiedUserId: VerifiedUserId,
    date: string,
    slotType: SlotType,
    skipIdempotencyCheck: boolean | undefined,
  ): Promise<void> {
    const existingToday = skipIdempotencyCheck
      ? null
      : await this.devotionals.getForDate(verifiedUserId, date, slotType);
    if (!existingToday) return;

    this.logger.info('Devotional already exists for today — skipping', {
      userId: verifiedUserId,
      date,
      devotionalId: existingToday.id,
    });
    // Find the most recent session for this devotional so we can return a URL.
    // If somehow no session exists (shouldn't happen in normal flow), use a
    // placeholder token — the devotional row is still the canonical signal.
    const existingSessions = await this.sessions.listForUser(verifiedUserId);
    const existingSession = existingSessions.find((s) => s.devotional_id === existingToday.id);
    const sessionToken = existingSession?.token ?? '';
    const sessionUrl = sessionToken ? sessionUrlFor(this.publicBaseUrl, sessionToken) : '';
    throw new AlreadyExistsError(existingToday.id, sessionToken, sessionUrl);
  }

  /**
   * Preference resolution (phase helper): either the caller's
   * `preferencesOverride` escape hatch completed with safe defaults, or a
   * real `loadPreferences` read.
   */
  private async resolveEffectivePreferences(
    params: GenerateNowParams,
  ): Promise<Awaited<ReturnType<GenerateNowOrchestrator['loadPreferences']>>> {
    if (!params.preferencesOverride) return this.loadPreferences(params.userId);
    return {
      // Escape-hatch default (O3 #315): an override caller that says
      // nothing about language gets today's English behavior — the
      // spread below lets it opt into a content language explicitly.
      language: DEFAULT_LANGUAGE,
      stillness: 'off' as Stillness,
      lectio: false,
      liturgicalSeasonsEnabled: false,
      // A `preferencesOverride` caller bypasses the preferences row, so
      // there is no stored consent to honor. `true` is right here rather
      // than a fail-safe `false` because these callers (invite-triggered
      // and team devotionals, tests) supply their own bands wholesale via
      // `bandsOverride` — which `resolveBands` already treats as
      // NO_SIGNALS_OBSERVED — so there is no `daily_bands` read for a
      // consent flag to protect. The override paths that do touch the
      // calendar still pass through the `connections` row, which is the
      // real grant.
      calendarEnabled: true,
      healthEnabled: true,
      communicationEnabled: true,
      // A caller supplying `preferencesOverride` is bypassing the
      // preferences row wholesale, so there is no stored duration to
      // honor — undefined lands on the band heuristic, and the voice
      // on the deployment default.
      durationPreference: undefined as DevotionalFormat | undefined,
      voiceName: DEFAULT_VOICE_NAME,
      ...params.preferencesOverride,
    };
  }

  /**
   * Band resolution (phase helper): the caller's `bandsOverride`, or a
   * consent-gated `loadBands` read — plus the distress override, which is
   * layered on top of whichever source won.
   *
   * `bandsOverride` arrives as a bare BandInput with no provenance attached,
   * and its callers are exactly the paths that generate from neutral bands
   * by design (invite-triggered devotionals in index.ts, team devotionals) or
   * that hand-build bands in tests. Treating those as unobserved is both
   * accurate for the production callers and the fail-safe reading for any
   * other: an override cannot vouch for measurement it never made (#196).
   */
  private async resolveBands(
    params: GenerateNowParams,
    date: string,
    consent: { calendarEnabled: boolean; healthEnabled: boolean; communicationEnabled: boolean },
  ): Promise<{ bands: BandInput; signalProvenance: SignalProvenance }> {
    const loaded = params.bandsOverride
      ? { bands: params.bandsOverride, provenance: NO_SIGNALS_OBSERVED }
      : await this.loadBands(params.userId, date, consent);
    const bands = params.distressSignalOverride
      ? { ...loaded.bands, distressSignal: true }
      : loaded.bands;
    return { bands, signalProvenance: loaded.provenance };
  }

  /**
   * Deliberate disclosure (phase helper — docs/14 §5.5, issue #93): weave
   * in whatever the user shared on yesterday's session-completion page, if
   * anything. Best-effort — a lookup failure here must never block
   * generation.
   */
  private async loadPrayerIntention(
    verifiedUserId: VerifiedUserId,
    date: string,
  ): Promise<string | undefined> {
    if (!this.prayerIntentions) return undefined;
    try {
      const row = await this.prayerIntentions.getForDate(verifiedUserId, previousIsoDate(date));
      return row?.text;
    } catch (err) {
      this.logger.error('Prayer intention lookup failed — continuing without it', {
        userId: verifiedUserId,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Feedback steering (phase helper — P7 #326, epic #312).
   *
   * Scheduled standard-slot generations only: the daily run passes
   * `applyFeedbackSteering: true`; generate-now, examen, invite, and
   * distress paths never do, so their params are untouched by
   * construction. The distress guard below is belt-and-braces on top of
   * that (safety paths must not depend on a caller remembering a flag).
   *
   * FAIL-OPEN, same ground rule as the daily run's adaptive-rhythm
   * evaluation: a broken steering read costs the nudges, never the
   * devotional.
   */
  private async deriveFeedbackSteering(
    params: GenerateNowParams,
    slotType: SlotType,
    verifiedUserId: VerifiedUserId,
    date: string,
  ): Promise<SteeringDecision> {
    if (
      !this.feedbackSteering ||
      !params.applyFeedbackSteering ||
      slotType !== 'standard' ||
      params.distressSignalOverride
    ) {
      return NO_STEERING;
    }
    try {
      const steering = await this.feedbackSteering.deriveSteering(verifiedUserId, {
        now: this.now(),
      });
      if (steering.reasons.length > 0) {
        this.logger.info('Feedback steering applied to generation params', {
          userId: verifiedUserId,
          date,
          reasons: steering.reasons,
          theme: steering.theme,
          durationNudge: steering.durationNudge,
          preferredTimeLocal: steering.preferredTimeLocal,
        });
      }
      return steering;
    } catch (err) {
      this.logger.error('Feedback steering failed — continuing unsteered', {
        userId: verifiedUserId,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
      return NO_STEERING;
    }
  }

  /**
   * Highlight weaving (phase helper — U4 #357). Returns the USFM passage to
   * weave in as "a verse you've marked", or undefined for no weave.
   *
   * Scoped exactly like feedback steering: standard-slot scheduled generations
   * that set `applyFeedbackSteering`, never distress. Precedence (the #326
   * idiom, highlight at the BOTTOM): if inviteContext, a prayer intention, or a
   * steered theme already shapes this devotional, the highlight yields — the
   * pure `decideHighlightWeaving` is told `higherPrecedenceActive` and returns
   * nothing. No-repeat: a passage already present in the last
   * {@link HIGHLIGHT_NO_REPEAT_DAYS} days of devotionals is skipped.
   *
   * FAIL-OPEN: any read/derive failure returns undefined (unwoven), never
   * throws — a YouVersion read outage costs the personalization, not the
   * devotional. §9: logs the reason code only, never a highlight count.
   */
  private async deriveHighlightWeaving(args: {
    params: GenerateNowParams;
    slotType: SlotType;
    verifiedUserId: VerifiedUserId;
    date: string;
    bands: BandInput;
    steeredTheme: string | undefined;
    prayerIntention: string | undefined;
  }): Promise<string | undefined> {
    const { params, slotType, verifiedUserId, date, bands } = args;
    if (
      !this.highlightsBridge ||
      !params.applyFeedbackSteering ||
      slotType !== 'standard' ||
      params.distressSignalOverride ||
      bands.distressSignal
    ) {
      return undefined;
    }
    try {
      const higherPrecedenceActive =
        params.inviteContext !== undefined ||
        args.prayerIntention !== undefined ||
        args.steeredTheme !== undefined;

      const highlights = await this.highlightsBridge.readRecentHighlights(verifiedUserId, {
        limit: HIGHLIGHT_READ_LIMIT,
      });

      // Derive the no-repeat set from recent devotionals' verses (no new
      // column): every passage the user has already seen woven recently.
      const sinceDate = previousIsoDateBy(date, HIGHLIGHT_NO_REPEAT_DAYS);
      const recent = await this.devotionals.listForUserInRange(verifiedUserId, sinceDate, date);
      const recentlyWovenPassageIds = recent.flatMap((d) => d.verses.map((v) => v.usfm));

      const decision = decideHighlightWeaving(highlights, {
        higherPrecedenceActive,
        recentlyWovenPassageIds,
      });

      if (decision.reason === 'highlight_woven') {
        // Reason + the woven passage id only — never a count of highlights (§9).
        this.logger.info('Highlight woven into generation', {
          userId: verifiedUserId,
          date,
          reason: decision.reason,
          passageRef: decision.passageRef,
        });
      }
      return decision.passageRef;
    } catch (err) {
      this.logger.error('Highlight weaving failed — continuing without it', {
        userId: verifiedUserId,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Audio pipeline (phase helper — Steps 3+4): synthesize, upload the MP3,
   * record it on the devotional row, and store the Stage timing manifest.
   * Best-effort as a whole: any failure degrades to the audio-unavailable
   * outcome and must never take down the request — a TTS failure must not
   * lose the generated devotional text.
   */
  private async synthesizeAndStoreAudio(args: {
    userId: string;
    verifiedUserId: VerifiedUserId;
    devotionalId: string;
    devotional: GenerateDevotionalResult['devotional'];
    stillness: Stillness;
    lectio: boolean;
    voiceName: string;
    language: LanguageTag;
    openMomentEnabled: boolean;
  }): Promise<GenerateNowAudioOutcome> {
    const { userId, verifiedUserId, devotionalId, devotional } = args;
    try {
      // `voiceName` is already catalog-validated by loadPreferences (#202) —
      // TtsService validates again on its own account, since it is a public
      // entry point other callers reach directly. `language` (O4 #316) makes
      // the synthesis speak the user's content language: TtsService derives
      // the locale (zh -> cmn-CN) and re-homes the voice name from it.
      const synthesized = await this.ttsService.synthesize(
        devotional,
        args.stillness,
        args.lectio,
        args.voiceName,
        args.language,
        args.openMomentEnabled,
      );
      const stored = await this.audioStorage.upload(devotionalId, synthesized.audio);
      await this.devotionals.setAudioObject(verifiedUserId, devotionalId, stored.objectKey);

      // Stage timing manifest (Q1 #331) — written right after the MP3 it
      // describes. Its OWN try/catch, inside the audio-success path: a
      // manifest failure must NOT fail generation and must NOT flip the
      // already-uploaded audio to `unavailable` — the Stage page simply
      // degrades to no-captions (same posture as other non-fatal audio
      // issues). An empty manifest means duration measurement itself
      // failed in TtsService; nothing useful to store.
      if ((synthesized.manifest?.length ?? 0) > 0) {
        try {
          await this.audioStorage.uploadManifest(devotionalId, synthesized.manifest);
        } catch (err) {
          this.logger.error('Timing-manifest upload failed — continuing without captions (#331)', {
            userId,
            devotionalId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.logger.info('TTS + upload succeeded', {
        userId,
        devotionalId,
        segmentCount: synthesized.segmentCount,
      });
      return { status: 'uploaded', objectKey: stored.objectKey };
    } catch (err) {
      const reason =
        err instanceof TtsServiceError
          ? err.message
          : `Unexpected audio pipeline failure: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error('TTS/upload failed — continuing with audio-unavailable session', {
        userId,
        devotionalId,
        reason,
      });
      return { status: 'unavailable', reason };
    }
  }

  async generateNow(params: GenerateNowParams): Promise<GenerateNowResult> {
    const { userId } = params;
    const date = params.date ?? todayIsoDate(this.now);
    const verifiedUserId = asVerifiedUserId(userId);
    const slotType: SlotType = params.slotType ?? 'standard';

    await this.ensureNotAlreadyGenerated(
      verifiedUserId,
      date,
      slotType,
      params.skipIdempotencyCheck,
    );

    const prefs = await this.resolveEffectivePreferences(params);
    const {
      tradition,
      language,
      translation,
      preferredVersionId,
      stillness,
      lectio,
      liturgicalSeasonsEnabled,
      voiceName,
      calendarEnabled,
    } = prefs;
    const { bands, signalProvenance } = await this.resolveBands(params, date, prefs);

    this.logger.info('Starting generate-now', {
      userId,
      date,
      tradition,
      language,
      translation,
      slotType,
    });

    const prayerIntention = await this.loadPrayerIntention(verifiedUserId, date);
    const steering = await this.deriveFeedbackSteering(params, slotType, verifiedUserId, date);

    // Step 1: DevotionalEngine — never throws for the "provider had a bad
    // day" case (falls back to fixture internally). Theme and duration each
    // resolve through an explicit precedence ladder; the ladders (and their
    // full rationale) live in resolveSteeredTheme / resolveDurationPreference
    // at module level, pure and directly testable.
    const steeredTheme = resolveSteeredTheme(steering, params, prayerIntention);
    const durationPreference = resolveDurationPreference(
      params,
      prefs.durationPreference,
      steering,
      bands,
      slotType,
    );
    // U4 (#357): resolve the highlight weave AFTER theme/prayer/invite are
    // known, so its precedence gate sees whether a higher signal already
    // steers. Undefined for every non-scheduled/unconsented/no-highlight path.
    const highlightedReference = await this.deriveHighlightWeaving({
      params,
      slotType,
      verifiedUserId,
      date,
      bands,
      steeredTheme,
      prayerIntention,
    });
    const genResult = await this.devotionalEngine.generate({
      bands,
      signalProvenance,
      tradition,
      translation,
      preferredVersionId,
      language,
      slotType,
      lectio,
      durationPreference,
      date,
      liturgicalSeasonsEnabled,
      prayerIntention,
      inviteContext: params.inviteContext,
      // Spread-conditional so an unsteered generation's params object is
      // byte-identical to pre-P7 (the #326 zero-feedback regression pin).
      ...(steeredTheme !== undefined ? { theme: steeredTheme } : {}),
      // Same spread-conditional posture (U4 #357): a generation with no woven
      // highlight is byte-identical to pre-U4.
      ...(highlightedReference !== undefined ? { highlightedReference } : {}),
    });
    const { devotional, source } = genResult;

    // Open Moment (EPIC V #360 / V4 #365): resolve the flag (distress NEVER),
    // then persist the generation context ONLY on a non-fixture generation (a
    // fixture has no live engine). `openMomentContext` non-null is BOTH the
    // per-devotional enable gate the respond route checks AND the exact
    // language/voice/tradition/translation the live answer must speak in.
    const openMomentEnabled =
      resolveOpenMomentEnabled(
        params.openMomentEnabled ?? false,
        bands.distressSignal,
        // V5 #366 kill switch — ANDed into the resolution so the live window
        // ships dark until an operator sets OPEN_MOMENT_ENABLED=true (V6).
        resolveOpenMomentKillSwitch(process.env.OPEN_MOMENT_ENABLED),
      ) && source !== 'fixture';
    const openMomentContext: OpenMomentContext | null = openMomentEnabled
      ? { language, tradition, translation, preferredVersionId, voiceName }
      : null;

    // Fixture fallback stays English by decision (epic #311 §3) — the
    // corpus is English-only, and an honest English fallback beats a
    // machine-translated one. For a non-English user that means this
    // devotional is NOT in their chosen language: the row/response already
    // carry `isFixtureFallback`, and this log line is the explicit
    // language-mismatch flag (O3 #315) so the demo/ops story never has to
    // infer it from the language column and the fixture flag separately.
    if (source === 'fixture' && language !== DEFAULT_LANGUAGE) {
      this.logger.info(
        'Fixture fallback served in English to a non-English user (epic #311 §3 decision)',
        {
          userId,
          date,
          language,
          fixtureLanguageMismatch: true,
        },
      );
    }

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
      openMoment: openMomentContext,
    });

    // Step 3+4: TTS + upload — best-effort. Any failure degrades to the
    // audio-unavailable path; must never take down the whole request.
    const audio = await this.synthesizeAndStoreAudio({
      userId,
      verifiedUserId,
      devotionalId: devotionalRow.id,
      devotional,
      stillness,
      lectio,
      voiceName,
      language,
      openMomentEnabled,
    });

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
    const skipCalendar =
      params.skipCalendar || slotType !== 'standard' || params.distressSignalOverride === true;
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
        // P7 (#326): the feedback-derived slot-time bias. Threaded from
        // the steering decision rather than re-read from the preferences
        // row inside the step, so ONLY steered (scheduled) generations
        // order gaps by it — a user-initiated generate-now keeps the
        // longest-gap-first behavior it has always had.
        preferredTimeLocal: steering.preferredTimeLocal,
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
    verifiedUserId: VerifiedUserId;
    devotionalRow: DevotionalRow;
    sessionRow: SessionRow;
    sessionUrl: string;
    /** D4/#32: the delivery provider's primary join link — equal to `sessionUrl` unless a richer provider (e.g. LiveKit) is wired. */
    joinUrl: string;
    devotional: import('../devotionalEngine.js').GenerateDevotionalResult['devotional'];
    date: string;
    /** P7 (#326): wall-clock slot preference (`HH:MM:SS`, already window-clamped) — orders candidate gaps by proximity when set. */
    preferredTimeLocal?: string;
  }): Promise<GenerateNowCalendarOutcome> {
    const { userId, verifiedUserId, devotionalRow, sessionRow, sessionUrl, joinUrl, devotional } =
      params;

    try {
      // 6a. Load the user's Google Calendar connection.
      const connection = await this.connections!.findByProvider(verifiedUserId, 'google_calendar');
      if (!connection || connection.status !== 'active') {
        this.logger.info('No active Google Calendar connection — skipping calendar step', {
          userId,
        });
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
        this.logger.info(
          'Scheduling window does not exist on this date (DST transition) — skipping calendar event',
          {
            userId,
            date: tomorrowStr,
            timezone: windowBounds.timeZone,
            windowStart,
            windowEnd,
          },
        );
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

      // An 'extended' (~15+ min) session — natural via bands or forced by
      // sabbathSession (docs/14 §5.6, issue #94) — stuffed into a 2-minute
      // gap would just get cut off; shorter formats have no such floor.
      const requiredMinutes =
        devotional.format === 'extended' ? EXTENDED_FORMAT_MIN_GAP_MINUTES : 0;
      // Gap choice (P7 #326, gapSelection.ts): without a preferred time
      // this is exactly the old rule — the analyzer's longest gap, floor-
      // checked. With one (feedback-derived `preferred_time_local`,
      // resolved on tomorrow's date in the window's own zone), the nearest
      // qualifying gap wins instead: the bias moves the slot WITHIN the
      // window the user stated, never the window itself.
      const preferredInstant = params.preferredTimeLocal
        ? resolvePreferredInstant(tomorrowStr, params.preferredTimeLocal, windowBounds.timeZone)
        : null;
      const bestGap = selectGap(analysis.gaps, requiredMinutes, preferredInstant);
      if (!bestGap) {
        this.logger.info('No suitable gap found — skipping calendar event', {
          userId,
          busyness: analysis.busyness,
          requiredMinutes,
        });
        return { skipped: 'no_gap_found' };
      }

      // 6g. Insert the calendar event. Body per the Wellspring Design
      // System §06 (T4 #351, eventBody.ts): exact verse text first, one
      // short reflection line, ONE "Begin your moment ↗" link. When the
      // delivery provider's joinUrl differs from the plain session page
      // (D4/#32 — e.g. LiveKit), the session page stays as an explicit
      // fallback line (DEC-K3) rather than disappearing.
      const firstVerse = devotional.verses[0];
      const eventDescription = buildEventBody({
        verse: firstVerse
          ? {
              reference: firstVerse.reference,
              fetchedText: firstVerse.fetchedText,
              attribution: firstVerse.attribution,
            }
          : null,
        reflection: devotional.cardSummary,
        beginUrl: joinUrl,
        fallbackUrl: sessionUrl,
      });

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
          this.logger.info('MeetBot dispatch scheduled', {
            userId,
            devotionalId: devotionalRow.id,
            gapStart: bestGap.start,
          });
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
