import { z } from 'zod';
import { DevotionalFormatSchema } from '../bands.js';
import { LanguageTagSchema } from '../language.js';
import { TimezoneIdSchema } from './timezone.js';

/**
 * `GET`/`PUT /v1/preferences` (docs/03 §8.1, docs/14 §2.9/§3.5 / issue
 * #72). Field set matches the `preferences` table exactly (migration
 * 1720000000000) and `PreferencesRepository.update`'s existing ~9-column
 * `COALESCE`-per-field UPDATE — this schema's job is to be the
 * request-side gate in front of that repository call so free text can no
 * longer reach enum-constrained columns (docs/14 §2.9: "PUT
 * /v1/preferences has zero Zod validation... free text into enum
 * columns").
 *
 * `tradition` lives on `users`, not `preferences` (a different
 * table/repository, `UsersRepository.updateProfile`) — docs/03 §8.1's
 * prose groups it with preferences conceptually, but it is intentionally
 * NOT part of this schema; wiring a users-profile PUT is a separate,
 * undertaken-elsewhere concern (issue #89 note). `translationId` used to
 * sit under the same exclusion, until Epic O (#311/#314) gave it a write
 * path — it now rides this route on the established `users`-table
 * exception (`timezone` #187, `onboardingCompleted` #225, and now
 * `language`/`translationId` #314), see the field docs below.
 *
 * `activeDays` is 0=Sunday..6=Saturday per the migration comment.
 * `windowStartLocal`/`windowEndLocal` are `HH:MM` or `HH:MM:SS` (Postgres
 * `time` column accepts either; validated loosely here as a light regex
 * rather than re-deriving Postgres's full time-literal grammar).
 *
 * Deliberately NOT `.strict()`: an unrecognized key (e.g. a client-
 * supplied `userId`, attempting to smuggle a different user's scoping
 * key into the body — Foundation §10 forbids trusting that regardless)
 * is silently stripped by Zod's default object parsing rather than
 * failing the whole request with 400. The route handler ever only reads
 * the validated, known fields off `parsed.data` and writes using
 * `request.auth.userId` (never anything from the body) — so a smuggled
 * field can never influence which row is written, whether it's stripped
 * or rejected. Stripping is the more forward-compatible choice here (a
 * client sending a slightly newer/larger payload than this server
 * version knows about should not 400).
 */
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const CadenceSchema = z.enum(['daily', 'weekdays', 'custom']);
export type Cadence = z.infer<typeof CadenceSchema>;

/**
 * ## The cadence ↔ active_days model (K2, issue #188)
 *
 * Before #188 both `cadence` and `active_days` were dead config — read by
 * nothing (docs/03 §10 traceability table, issue #193). #188 makes
 * `active_days` the value the daily run actually consumes, which forces a
 * decision the two fields had been able to dodge: they overlap, and they
 * can contradict. `cadence: 'daily'` alongside `active_days: {1,2,3,4,5}`
 * is not a rare corner — it is the **stored default of every row**
 * (migration 1720000000000 defaults `cadence` to `'daily'` and
 * `active_days` to `{1,2,3,4,5}`), and nothing before this ever had to
 * decide which of the two the user meant.
 *
 * The model chosen (issue #188 option (b), refined): **`active_days` is
 * the single source of truth; `cadence` is a derived label.**
 *
 *   - The daily run reads `active_days` and only `active_days`. There is
 *     exactly one field to consult, so "which one wins" has no answer to
 *     get wrong.
 *   - `cadence` is a *name* for a day set, not an independent setting:
 *     all seven days is called "daily", Mon–Fri is called "weekdays",
 *     anything else is "custom". It is recomputed on every write, so a
 *     stored pair can never disagree — contradictory state is
 *     unrepresentable rather than merely discouraged.
 *   - In the UI, picking a cadence is a *preset* that writes the day set
 *     (Daily → all seven, Weekdays → Mon–Fri). Picking "Custom" is not a
 *     day set of its own; it is what you see when your days match neither
 *     preset, which is why #189's day circles are the Custom surface
 *     rather than a redundant second control.
 *
 * The iOS client already worked this way in one direction —
 * `HTTPPreferencesClient.updateBody` derives the `cadence` string from
 * `preferences.days` rather than from a stored flag. This makes the server
 * agree with it, rather than leaving the two ends of the wire holding
 * different theories about which field is authoritative.
 */
const ALL_DAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Normalizes a day set for comparison/storage: de-duplicated and ascending. */
function normalizeDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

/**
 * The label for a day set — the derivation direction the daily run's
 * source of truth flows in. Order/duplicates in the input do not matter.
 */
export function cadenceForActiveDays(activeDays: readonly number[]): Cadence {
  const normalized = normalizeDays(activeDays);
  if (sameDays(normalized, ALL_DAYS)) return 'daily';
  if (sameDays(normalized, WEEKDAYS)) return 'weekdays';
  return 'custom';
}

/**
 * The day set a cadence preset stands for, or `undefined` for `'custom'`.
 *
 * `'custom'` deliberately expands to nothing rather than to some default
 * set: it means "the days I picked", so the only honest reading of a
 * cadence-only write of `'custom'` is "leave my days alone". A caller that
 * wants to *change* the days sends `activeDays`.
 */
export function activeDaysForCadence(cadence: Cadence): number[] | undefined {
  if (cadence === 'daily') return [...ALL_DAYS];
  if (cadence === 'weekdays') return [...WEEKDAYS];
  return undefined;
}

/**
 * Stillness (docs/14 §5.2): a spoken hand-off + genuine encoded silence
 * after the verse and again after the prayer, then a gentle re-entry.
 * `off` preserves today's behavior exactly; `brief`/`full` set the
 * silence duration (see STILLNESS_MS in ssmlBuilder.ts).
 */
export const StillnessSchema = z.enum(['off', 'brief', 'full']);
export type Stillness = z.infer<typeof StillnessSchema>;

/**
 * The cadence engine's reason codes (Epic P #312 — `CadenceReason` in the
 * API's cadencePolicy.ts, CHECK-constrained by migration 1722500000000).
 * On the wire so P8's settings card (#327) can map code → grace copy;
 * codes only, never prose, and never any count of missed sessions
 * (Foundation §9: grace may notice, it may never charge). The API keeps a
 * compile-time both-ways assertion against its `CadenceReason` union
 * (rhythmSummary.ts), so the two lists cannot drift silently.
 */
export const RhythmReasonSchema = z.enum([
  'fixed_by_user',
  'easing_back',
  'welcoming_back',
  'hold',
  'at_floor',
  'at_ceiling',
  'no_data',
]);
export type RhythmReason = z.infer<typeof RhythmReasonSchema>;

/**
 * The server-composed "Your rhythm" summary on `GET`/`PUT /v1/preferences`
 * (P8 #327): what the adaptive engine is currently doing, in aggregates a
 * client may render.
 *
 * **`.strict()` is the §9 guarantee, not a style choice.** Every field is
 * a schedule fact (days per week, a floor, a mode, a reason code) — the
 * same class of number as `activeDays`. What must never ride here is
 * *practice accounting*: attendance counts or ratios, dates, per-day
 * history, anything "missed". The closed shape means adding such a field
 * fails the contract test (and the web client's parse) rather than
 * quietly widening — the structural version of #282's "single value,
 * never a history array" rule. Re-arguing §9-safety is the price of
 * adding a field here, on purpose.
 */
export const RhythmSchema = z
  .object({
    /** 'fixed' when the user opted out ("keep my schedule fixed", `adaptiveEnabled: false`). */
    mode: z.enum(['adaptive', 'fixed']),
    /** Current effective schedule — a schedule fact, like `activeDays`. */
    daysPerWeek: z.number().int().min(1).max(7),
    /** The user's floor: the engine never schedules fewer days/week than this. */
    minPerWeek: z.number().int().min(1).max(7),
    reason: RhythmReasonSchema,
  })
  .strict();
export type Rhythm = z.infer<typeof RhythmSchema>;

/**
 * YouVersion connection status on `GET`/`PUT /v1/preferences` (U2/U5,
 * kairos-devotional#355). A CLOSED (`.strict()`) shape carrying ONLY whether
 * an account is connected and, if so, the display name to show ("Connected as
 * …") — Foundation §9's hardest line for this feature: NOTHING about what the
 * user reads, highlights, or has ever highlighted may ride here. The closed
 * shape means a field like `highlightCount` or `lastHighlightedAt` fails the
 * contract test (and the web client's parse) rather than quietly widening —
 * the structural guarantee, not a convention. U4/U5 consume this; this story
 * owns it.
 */
export const YouVersionConnectionSchema = z
  .object({
    connected: z.boolean(),
    /** Display name of the connected account, absent when not connected or unknown. */
    displayName: z.string().optional(),
  })
  .strict();
export type YouVersionConnection = z.infer<typeof YouVersionConnectionSchema>;

export const PreferencesUpdateRequestSchema = z.object({
  windowStartLocal: z.string().regex(TIME_REGEX, 'must be HH:MM or HH:MM:SS').optional(),
  windowEndLocal: z.string().regex(TIME_REGEX, 'must be HH:MM or HH:MM:SS').optional(),
  /**
   * 0=Sunday..6=Saturday. **At least one day** since K2 (#188): before
   * #188 `active_days` was read by nothing, so an empty array was inert;
   * now it is the daily run's gate, and storing `[]` means "never
   * generate a devotional again, silently" — which is not a thing any UI
   * offers or any user means by editing their days (`OnboardingPreferences.validated()`
   * on iOS has always repaired an empty set back to Mon–Fri for exactly
   * this reason). A user who wants Wellspring to stop disconnects their
   * calendar or deletes their account; both are visible, reversible acts.
   * A loud 400 is the right answer to a client that would otherwise
   * quietly turn the product off.
   */
  activeDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  /**
   * A *preset* that writes `activeDays`, not an independent setting — see
   * `cadenceForActiveDays` above for the model. When sent alongside
   * `activeDays`, the days win and this value is recomputed from them.
   */
  cadence: CadenceSchema.optional(),
  /**
   * Absent = leave the stored value alone; explicit `null` = "auto", i.e.
   * let the band heuristic pick the length (issue #202, migration
   * 1721500000000). The enum has no `auto` member, so null carries it.
   */
  durationPreference: DevotionalFormatSchema.nullable().optional(),
  /**
   * Accepts either a picker label (`warm`/`calm`/`bright`, what iOS pushes)
   * or a real Chirp 3 HD voice id — both are genuinely present in the
   * column. Still a loose `z.string()` rather than an enum because the
   * column is plain `text` with no DB-level constraint, so a stale or
   * out-of-band value must round-trip through the API rather than 400 on
   * read; `resolveVoiceName` (voice.ts) is what gates it before it can
   * reach Cloud TTS. See #202.
   */
  voice: z.string().min(1).max(200).optional(),
  stillness: StillnessSchema.optional(),
  /**
   * Lectio divina mode (docs/14 §5.4 / issue #92): when true, TTS
   * restructures the script as verse (slower on the second pass) -> silence
   * -> meditative question -> silence -> prayer, instead of the ordinary
   * verse -> devotionalBody -> prayer flow. Defaults to false — today's
   * behavior is unchanged.
   */
  lectio: z.boolean().optional(),
  calendarEnabled: z.boolean().optional(),
  healthEnabled: z.boolean().optional(),
  communicationEnabled: z.boolean().optional(),
  notifyOnSkip: z.boolean().optional(),
  examenEnabled: z.boolean().optional(),
  /**
   * Sabbath awareness (docs/14 §5.6 / issue #94): a weekly rest day,
   * 0=Sunday..6=Saturday (same convention as `activeDays`). Opt-in via
   * `sabbathEnabled` (defaults false). `sabbathSession`, when true, asks
   * the daily run for an extended, action-step-free contemplative session
   * on that day instead of skipping generation outright.
   */
  sabbathDay: z.number().int().min(0).max(6).optional(),
  sabbathEnabled: z.boolean().optional(),
  sabbathSession: z.boolean().optional(),
  /**
   * Liturgical seasons (docs/14 §5.7 / issue #95): opts evangelical/general
   * traditions into a devotional instructions line naming the current
   * liturgical season (Advent, Christmastide, Lent, Eastertide, Ordinary
   * Time). Catholic/mainline traditions see this line automatically,
   * regardless of this flag. Defaults false.
   */
  liturgicalSeasonsEnabled: z.boolean().optional(),
  /**
   * YouVersion highlight consent gates (U4/U5, kairos-devotional#355). Both
   * default false server-side (migration 1722700000000) and are independently
   * revocable (Foundation §8), same shape as `calendarEnabled`/`healthEnabled`
   * above — except these default FALSE, because connecting a YouVersion
   * account is deliberately NOT consent to read or write highlights. A client
   * can toggle either without touching the connection itself.
   */
  yvWriteHighlights: z.boolean().optional(),
  yvReadHighlights: z.boolean().optional(),
  /**
   * Adaptive rhythm floor (Epic P #312 / P5 #324, migration
   * 1722500000000): the cadence engine never schedules fewer days/week
   * than this, however long invitations go unjoined. 1..7, default 2.
   *
   * Note what is deliberately NOT in this schema: the engine's own state
   * (`adaptive_days_per_week`, `adaptive_reason`, `adaptive_decided_at`).
   * Those are server-written only — a client field for them would let any
   * caller overwrite the engine's ladder position and its one-step-per-week
   * rate limiter. Because this object strips unknown keys (see the
   * non-`.strict()` note above), a client that sends them anyway is
   * harmlessly ignored rather than 400'd, and the route's `updates` map
   * never names them, so they cannot reach the repository from here.
   */
  minPerWeek: z.number().int().min(1).max(7).optional(),
  /**
   * The "keep my schedule fixed" opt-out (Epic P #312): `false` bypasses
   * the cadence engine entirely — `active_days` is used exactly as
   * stated, and attendance signals are never consulted. Default true.
   */
  adaptiveEnabled: z.boolean().optional(),
  /**
   * The device's own IANA zone (`TimeZone.current.identifier` on iOS),
   * issue #187. The one field in this schema that does NOT live on the
   * `preferences` table — it writes `users.timezone`, same table
   * exception the doc comment above already calls out for
   * `tradition`/`translationId`. It rides on the preferences sync anyway
   * because that is the first authenticated write a new user makes, and
   * #187's requirement is that a zone lands *before* any calendar is
   * connected (and for the users who never connect one).
   *
   * Validated as a real IANA identifier, so a malformed value 400s the
   * whole request rather than being quietly dropped. That is the same
   * treatment every other field here gets (`cadence: "banana"` already
   * fails the request), and `TimeZone.current.identifier` cannot produce
   * an invalid id — so a 400 here means a genuinely broken client, which
   * should be loud rather than silently scheduling someone's devotional
   * against a bogus zone.
   */
  timezone: TimezoneIdSchema.optional(),
  /**
   * Marks onboarding finished server-side (issue #225, migration
   * 1721800000000). Like `timezone` above, this is not a `preferences`
   * column — it writes `users.onboarded_at` — and rides this route for the
   * same reason: it is the one authenticated call every client already
   * makes, so a second endpoint would buy nothing but a second round trip
   * that can fail independently.
   *
   * `z.literal(true)`, not `z.boolean()`, and that is the whole design.
   * There is no wire representation of "un-onboard me", so no client bug,
   * no stale cache, and no replayed request can take a user who has
   * finished onboarding and put them back through it. A `false` is a 400,
   * loudly, rather than a silently-ignored no-op — a client sending it has
   * misunderstood the field and should find out.
   *
   * Absent means "no opinion", which is what every ordinary preferences
   * save sends: the flag is not a mirror of client state to be
   * re-asserted, it is an event ("they just finished"). The server side is
   * first-write-wins anyway (`UsersRepository.markOnboarded`), so a client
   * that does re-assert it on every sync is harmless — it just cannot move
   * the recorded instant.
   */
  onboardingCompleted: z.literal(true).optional(),
  /**
   * Devotional content language (Epic O #311, story #314) — the third and
   * fourth fields in this body that are not `preferences` columns: this
   * writes `users.language` (migration 1722300000000) and `translationId`
   * below writes `users.translation_id`, riding this route on the same
   * `users`-table exception as `timezone`/`onboardingCompleted` above.
   *
   * The two are one choice wearing two fields, and the route makes
   * contradictory state unrepresentable in the same spirit as
   * `cadence`↔`activeDays`: a language *change* with no `translationId`
   * snaps `translation_id` to the new language's default
   * (`defaultVersionIdFor`, language.ts), and a `translationId` outside
   * the chosen — or, when absent, the stored — language's catalog fails
   * the whole request with 400 rather than storing a Bible the language
   * cannot read. Re-asserting the stored language unchanged snaps
   * nothing: full-object PUT clients faithfully re-send this field on
   * every save, and a round-trip must never clobber an explicit
   * alternate translation (same lesson as the cadence reconciliation).
   */
  language: LanguageTagSchema.optional(),
  /**
   * YouVersion numeric version id (`users.translation_id`) — writable at
   * last (#314): the column has existed since the first migration with no
   * API able to change it (web renders a disabled select over it; iOS
   * captures a choice it can never push). Positive-int here is only the
   * shape gate; catalog membership against the effective language is the
   * route's cross-field rule, since it needs the stored row to evaluate.
   */
  translationId: z.number().int().positive().optional(),
});
export type PreferencesUpdateRequest = z.infer<typeof PreferencesUpdateRequestSchema>;

/** Response payload for both `GET` and `PUT /v1/preferences` — the full stored row, camelCased for the wire. */
export const PreferencesResponseDataSchema = z.object({
  userId: z.string(),
  windowStartLocal: z.string(),
  windowEndLocal: z.string(),
  activeDays: z.array(z.number().int().min(0).max(6)),
  cadence: z.string(),
  // Nullable since #202: `null` is the stored representation of "auto"
  // (migration 1721500000000), which the iOS picker offers and the enum
  // cannot express.
  durationPreference: DevotionalFormatSchema.nullable(),
  voice: z.string(),
  // Plain `z.string()`, not `StillnessSchema` — like `cadence` above, this
  // is a Postgres `text` column (not a DB-level enum type), so unlike
  // `durationPreference` the database itself doesn't guarantee the value
  // is one of the three variants; `StillnessSchema` gates writes instead.
  stillness: z.string(),
  // `lectio` IS a real Postgres `boolean` column (migration 1720950000000),
  // unlike `stillness`/`cadence` above, so `z.boolean()` here is authoritative.
  lectio: z.boolean(),
  calendarEnabled: z.boolean(),
  healthEnabled: z.boolean(),
  communicationEnabled: z.boolean(),
  notifyOnSkip: z.boolean(),
  examenEnabled: z.boolean(),
  // Sabbath columns are real Postgres `smallint`/`boolean` columns
  // (migration 1721000000000), same "DB is authoritative" reasoning as
  // `lectio` above — no extra Zod re-validation needed on the read side.
  sabbathDay: z.number().int().min(0).max(6),
  sabbathEnabled: z.boolean(),
  sabbathSession: z.boolean(),
  // Real Postgres `boolean` column (migration 1721100000000), same
  // "DB is authoritative" reasoning as `lectio`/sabbath columns above.
  liturgicalSeasonsEnabled: z.boolean(),
  /**
   * YouVersion highlight consent gates (U4/U5, kairos-devotional#355). Real
   * Postgres `boolean` columns (migration 1722700000000), so the DB is
   * authoritative — but `.optional()` here, unlike the always-present
   * `calendarEnabled`, follows the #244 policy the `rhythm` field below also
   * follows: a client running a version behind (or ahead of) its server
   * renders NOTHING for the YouVersion controls rather than failing the whole
   * preferences parse. The deployed server always composes both.
   */
  yvWriteHighlights: z.boolean().optional(),
  yvReadHighlights: z.boolean().optional(),
  /**
   * YouVersion connection status (U2, kairos-devotional#355) — the
   * closed-shape §9-safe object (`YouVersionConnectionSchema` above): status +
   * display name ONLY, never any highlight/activity data. `.optional()` for
   * the same #244 reason as `rhythm`/`yv*` above; the deployed server always
   * composes it from the connections store.
   */
  youversionConnection: YouVersionConnectionSchema.optional(),
  // Adaptive rhythm (P5 #324, migration 1722500000000). Only the two
  // user-owned fields are echoed back; the engine's state columns
  // (`adaptive_days_per_week`/`adaptive_reason`) are deliberately absent
  // from the wire in this story — surfacing them is P8's job (#327), as
  // §9-safe composed copy, not raw state. `smallint`/`boolean` columns
  // with CHECK constraints, so the DB is authoritative on ranges.
  minPerWeek: z.number().int().min(1).max(7),
  adaptiveEnabled: z.boolean(),
  /**
   * Server-composed rhythm summary (P8 #327) — see `RhythmSchema` above
   * for the closed-shape §9 reasoning. `.optional()` rather than required
   * so a client running ahead of (or behind) its server renders *nothing*
   * for the card instead of failing the whole preferences parse — the
   * #244 policy: an absent capability disappears, it never becomes a
   * placeholder control. The deployed server always composes it
   * (`toPreferencesResponseData`).
   */
  rhythm: RhythmSchema.optional(),
  /**
   * ISO-8601 instant when this user finished onboarding, or `null` if they
   * never have (`users.onboarded_at`, migration 1721800000000, issue #225).
   * The only field in this payload that does not come from the
   * `preferences` table on the read side — same table exception as
   * `timezone` on the write side, and here for the same reason: this is
   * the call both clients already make at sign-in and on foreground, so
   * putting cross-surface identity state anywhere else would mean a second
   * request that can fail on its own.
   *
   * **`null` does not mean "show onboarding".** Clients treat completion
   * as a latch (`null` here plus a local cache saying "done" still means
   * done, and should trigger a write-back of `onboardingCompleted: true`).
   * The reason is that this field's absence is indistinguishable from a
   * user who onboarded on a device before #225 shipped, or offline. See
   * docs/02 §4 "Server-authoritative user state".
   */
  onboardedAt: z.string().nullable(),
  /**
   * The user's resolved IANA time zone (`users.timezone`), echoed back so a
   * client can render times in the zone the SERVER schedules in.
   *
   * Until now this was push-only (#187): clients could write it and never
   * read it. That made two Epic L requirements literally unsatisfiable —
   * rendering times in the profile zone rather than the browser's, and
   * #246's "adopted timezone visible when connected". A client with no way
   * to read the value can only guess with `Intl`, which silently disagrees
   * the moment a user travels, and disagreeing about the hour is the whole
   * substance of #205.
   *
   * Cheap to serve: the route already loads the `users` row for
   * `onboardedAt`, so this rides a query that was happening anyway.
   */
  timezone: TimezoneIdSchema,
  /**
   * The user's invite routing address, `u_<userId>@<INVITE_EMAIL_DOMAIN>`
   * (L3, issue #239) — add it as a guest on any calendar invite and Wellspring
   * brings a devotional to that meeting (Epic I / docs/12 §1.4.1).
   *
   * ## Why it rides this payload
   *
   * Same reasoning as `onboardedAt` above, and #225's before it: this is
   * the one authenticated call both clients already make on sign-in and on
   * foreground. A dedicated `GET /v1/invite-address` would buy a second
   * round trip that can fail on its own, for a field that is a pure
   * function of a userId the caller has already been authenticated as.
   *
   * ## Why `.optional()` — absent, not empty, not a broken address
   *
   * `INVITE_EMAIL_DOMAIN` is a ⚠️ must-confirm value (Foundation §11): it
   * is a Resend dev subdomain today and may be unset in a fresh
   * environment entirely. With no domain there is no address, and the two
   * dishonest encodings are both worse than absence:
   *
   *  - `""` is a value a client will happily render into a card, giving
   *    the user an empty box to copy nothing out of.
   *  - `u_<uuid>@undefined` is an address-shaped string that a user could
   *    copy, paste into a real calendar invite, and watch bounce.
   *
   * Absent is unambiguous and is the signal the clients key their card's
   * visibility off (#239: "Card absent (not broken) when
   * `INVITE_EMAIL_DOMAIN` unset"). It is *not* a secret — the address is
   * the capability — so this being present is not a disclosure decision,
   * only a configuration one.
   */
  inviteAddress: z.string().optional(),
  /**
   * Devotional content language (`users.language`, #314). Plain
   * `z.string()`, not `LanguageTagSchema` — same reasoning as `stillness`
   * above: the column is unconstrained `text`, so the write side
   * (`LanguageTagSchema` in the request schema) is the gate and the read
   * side must round-trip whatever is stored rather than 400 a GET.
   */
  language: z.string(),
  /**
   * `users.translation_id` (#314) — until now readable nowhere, which is
   * how web ended up hard-coding its disabled select's display value.
   * Real Postgres `integer NOT NULL` column, so the DB is authoritative
   * on the read side (same reasoning as `lectio` above).
   */
  translationId: z.number().int(),
  updatedAt: z.string(),
});
export type PreferencesResponseData = z.infer<typeof PreferencesResponseDataSchema>;

export const PreferencesResponseSchema = z.object({
  ok: z.literal(true),
  data: PreferencesResponseDataSchema,
});
export type PreferencesResponse = z.infer<typeof PreferencesResponseSchema>;
