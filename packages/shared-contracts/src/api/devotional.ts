import { z } from 'zod';
import { DevotionalFormatSchema } from '../bands.js';
import { VerseSchema } from '../devotional.js';

/**
 * `POST /v1/devotional/generate-now` (issue #77 for the distress path,
 * issue #238 for the "+" path) and the paginated `GET /v1/devotionals`
 * list (issue #241).
 */

/**
 * ## Why this endpoint has a mode instead of a sibling (issue #238)
 *
 * `POST /v1/devotional/generate-now` was built as the **distress
 * check-in** front door (docs/14 §5.8, issue #77): "I could use a moment
 * now". Everything about its behavior is shaped by that — it forces
 * `bands.distressSignal = true` (which pushes the engine into elevated
 * care and a `micro` format), and it bypasses the same-day idempotency
 * guard so someone reaching for that button always gets a fresh session
 * even if today's ordinary devotional already exists.
 *
 * L2 (#238) adds a second caller with the opposite needs: the dashboard's
 * "+" button. A routine tap is not a distress signal, and framing it as
 * one would be a category error with pastoral consequences — a user who
 * pressed "+" out of ordinary interest would receive a short, crisis-
 * shaped devotional with a resource pointer attached.
 *
 * The two share one endpoint and one orchestrator rather than forking,
 * because the *pipeline* is genuinely identical (prefs -> engine -> TTS ->
 * storage -> devotional row -> session row). What differs is three
 * booleans handed to `generateNow`, which is exactly what a mode
 * discriminator is for. Forking would duplicate the orchestrator call
 * site, and every future orchestrator parameter would then have two
 * places to be forgotten in.
 *
 * ### Why the default is `distress`, not `now`
 *
 * The shipped iOS distress button sends `{}` or `{ distressSignal: true }`
 * — it has no notion of this field. Defaulting to `distress` makes an
 * omitted mode byte-identical to today's behavior, so no deployed client
 * changes meaning under this release. The "+" surfaces are the new
 * callers, so they are the ones that must say what they are. The
 * alternative (default `now`) would silently convert every existing
 * distress press into an ordinary generation the moment this deploys —
 * a regression in the one path where getting it wrong matters most.
 */
export const GenerateNowModeSchema = z.enum(['distress', 'now']);
export type GenerateNowMode = z.infer<typeof GenerateNowModeSchema>;

export const GenerateNowRequestSchema = z.object({
  mode: GenerateNowModeSchema.default('distress'),
  /**
   * The original distress-path field (#77). Only meaningful when
   * `mode` is `distress`, where `false` is the sole way to ask that path
   * NOT to force the signal; the route ignores it entirely in `now` mode,
   * since a routine "+" tap asserting a distress signal is not a request
   * this endpoint should honor from the wire.
   */
  distressSignal: z.boolean().optional(),
});
export type GenerateNowRequest = z.infer<typeof GenerateNowRequestSchema>;

/**
 * Card fields for one row of `GET /v1/devotionals` (issue #241).
 *
 * **`devotionalBody`, `prayer`, `verses`, and `actionStep` are
 * deliberately absent.** The list previously returned whole rows
 * (`SELECT *`), which for a user with a year of daily devotionals is
 * ~365 full devotional bodies — tens of thousands of words — to render a
 * list of themes. Bodies live on `GET /v1/devotionals/:id`, which is the
 * call a client makes when the user actually opens one.
 *
 * `completedAt` comes from the linked `sessions` row, not `devotionals` —
 * it is the "did I actually sit with this" state #241 asks each row to
 * show, and it is the only field here that is not a devotionals column.
 */
export const DevotionalCardSchema = z.object({
  id: z.string(),
  date: z.string(),
  theme: z.string(),
  cardSummary: z.string(),
  format: DevotionalFormatSchema,
  createdAt: z.string(),
  /** ISO-8601 instant the user completed the linked session, or `null` if they never did. */
  completedAt: z.string().nullable(),
});
export type DevotionalCard = z.infer<typeof DevotionalCardSchema>;

/**
 * Cursor page of devotional cards, newest first (issue #241).
 *
 * `nextCursor` is an **opaque** string — clients must round-trip it
 * verbatim and never parse it. It currently encodes the sort key of the
 * last row on the page (date + created_at + id), which is what makes
 * paging stable across same-date rows (a user can hold both a `standard`
 * and an `examen` devotional for one date, so `date` alone is not a
 * unique key and a date-only cursor would skip or repeat rows).
 *
 * `null` means "this was the last page" — distinct from an empty string,
 * which would be a valid-looking cursor a client might send back.
 */
export const DevotionalListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(DevotionalCardSchema),
  nextCursor: z.string().nullable(),
});
export type DevotionalListResponse = z.infer<typeof DevotionalListResponseSchema>;

/**
 * `POST /v1/devotional/generate-now` response (L2, issue #238).
 *
 * Written from the handler in `apps/api/src/routes/userScoped.ts`, which
 * returns this object literally rather than validating against a schema —
 * so this is a *description* of that route, and the two are kept honest by
 * the client parsing every response through it. A drift shows up as a
 * parse failure on the button press instead of as an `undefined` inside a
 * card the user is waiting on.
 *
 * ## `alreadyExisted` is the whole point of this shape
 *
 * The endpoint answers a second same-day press with `200 ok:true,
 * alreadyExisted: true` and the *existing* session, not a 409 and not a
 * duplicate generation. Clients branch on the boolean to pick copy
 * ("Today's devotional is ready — open it") — never to render an error.
 * It is always present, so a client branches on a value rather than on the
 * absence of a key.
 *
 * `source` and `audio` are nullable for the same reason: on the
 * already-existed branch no generation happened on this request, and
 * reporting a fabricated `'gloo'`/`'uploaded'` would be a claim about work
 * never done.
 */
export const GenerateNowResponseSchema = z.object({
  ok: z.literal(true),
  sessionUrl: z.string(),
  devotionalId: z.string(),
  alreadyExisted: z.boolean(),
  data: z.object({
    sessionToken: z.string(),
    source: z.string().nullable(),
    audio: z.unknown().nullable(),
    /**
     * Best-effort on the already-existed branch: the handler re-reads the
     * row for the theme/summary and logs-and-continues if that read fails,
     * because a failed lookup must not turn a successful "here is your
     * devotional" into an error. `null` therefore means "open the session
     * anyway" — never "generation failed".
     */
    devotional: z
      .object({
        format: z.string(),
        theme: z.string(),
        cardSummary: z.string(),
      })
      .nullable(),
  }),
});
export type GenerateNowResponse = z.infer<typeof GenerateNowResponseSchema>;

/**
 * `GET /v1/devotionals/:id` (L5, issue #241) — the full devotional.
 *
 * **snake_case on purpose.** This route returns the database row
 * unmapped (`return { ok: true, data: row }`), so the wire genuinely
 * carries `card_summary` and `devotional_body`. Describing it accurately
 * is better than a camelCase schema that would silently drop every field;
 * the mapping to a UI shape happens in the client, in one place, where it
 * can be tested.
 *
 * Deliberately tolerant: `.passthrough()`-style optionality on the fields
 * no client reads, and `z.unknown()` for `verses` entries would be too
 * loose — `VerseSchema` is the real contract for those and is reused.
 */
export const DevotionalDetailSchema = z.object({
  id: z.string(),
  date: z.string(),
  format: DevotionalFormatSchema,
  theme: z.string(),
  verses: z.array(VerseSchema),
  devotional_body: z.string(),
  card_summary: z.string(),
  prayer: z.string(),
  journaling_prompt: z.string().nullable(),
  action_step: z.string().nullable(),
  /**
   * The GCS object name, or `null` when audio was never synthesized or has
   * been purged by retention (#82). Not a URL and not playable — audio is
   * fetched from `GET /v1/devotionals/:id/audio`, which mints a fresh
   * signed URL. A client must not try to build a URL from this.
   */
  audio_object: z.string().nullable(),
  created_at: z.string(),
});
export type DevotionalDetail = z.infer<typeof DevotionalDetailSchema>;

export const DevotionalDetailResponseSchema = z.object({
  ok: z.literal(true),
  data: DevotionalDetailSchema,
});
export type DevotionalDetailResponse = z.infer<typeof DevotionalDetailResponseSchema>;
