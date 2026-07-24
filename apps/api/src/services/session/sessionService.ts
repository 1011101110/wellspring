/**
 * SessionService — EPIC D (issues #31, #33). Architecture §2.1:
 * "creates session rows keyed by UUIDv4 token at scheduling time; serves
 * the session page ... tokens expire (event end + 48h) and are
 * single-user." This module owns the *read* (render) and *complete*
 * sides of the public join flow; session-row *creation* happens
 * wherever a devotional is scheduled (a later/parallel stage) via
 * `SessionsRepository.create` directly — not duplicated here.
 *
 * Enumeration safety (docs/04_DATA_PRIVACY_SECURITY.md §5.4): "GET
 * /session/:token returns identical 404 for unknown vs
 * expired-and-purged tokens." We go further and also treat a token that
 * still exists in the DB but is *past* `expires_at` as the same "gone"
 * case — from the caller's perspective a not-yet-purged expired row and
 * an already-purged one must be indistinguishable (purging is an
 * internal retention detail, docs/04 §retention: "purged 7 days after
 * expiry", i.e. there is a real window where an expired token is still
 * a row in the table and must still 404 identically).
 */
import type {
  GlooEngagementSummary,
  SessionFeedbackBody,
  SlotType,
  TimingManifest,
} from '@kairos/shared-contracts';
import type { AudioStorage, SignedUrlOptions } from '../audio/audioStorage.js';
import {
  asVerifiedUserId,
  type DailyBandsRepository,
  type DevotionalsRepository,
  type GlooEngagementSummariesRepository,
  type PrayerIntentionsRepository,
  type SessionFeedbackRepository,
  type SessionsRepository,
} from '../../db/repositories/index.js';
import type { GlooSummaryService } from '../gloo/glooSummaryService.js';
import type { SessionPageData } from './renderSessionPage.js';

export type SessionLookupResult = { kind: 'not_found' } | { kind: 'ok'; page: SessionPageData };

/**
 * Stage-page lookup (Q2 #332): the same enumeration-collapsed page data
 * as `SessionLookupResult`, plus the Q1 timing manifest (null when absent
 * or unreadable — the page degrades to no-captions) and the devotional's
 * `slot_type` (T3 #350 residual, epic #347): `examen` selects the
 * evening/dark stage variant ("light for morning, dark for evening"),
 * `standard` the light one. Stage-only — the /session page renders the
 * same light chrome for both slots, so `SessionPageData` stays slot-blind.
 */
export type StageLookupResult =
  | { kind: 'not_found' }
  | { kind: 'ok'; page: SessionPageData; manifest: TimingManifest | null; slotType: SlotType };

export type SessionCompleteResult = { kind: 'not_found' } | { kind: 'ok'; completedAt: Date };

/**
 * `not_joined` (P1 #320's joined-gate): the token is real and live but the
 * session was never opened — feedback about a devotional nobody saw is
 * noise the policy engine must not ingest. Distinct from `not_found` so
 * the route can answer 409 (see routes/session.ts for why that is not an
 * enumeration leak) instead of lying with the "gone" page.
 */
export type SessionFeedbackResult = { kind: 'not_found' } | { kind: 'not_joined' } | { kind: 'ok' };

/** What the post-Amen confirmation page needs (P2 #321): whose form to render, and whether to render it at all. */
export type SessionCompletionViewResult =
  | { kind: 'not_found' }
  | { kind: 'ok'; token: string; feedbackSubmitted: boolean };

export interface SessionServiceLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: SessionServiceLogger = {
  error: (msg, meta) => console.error(`[sessionService] ${msg}`, meta ?? ''),
};

export interface SessionServiceDeps {
  sessions: SessionsRepository;
  devotionals: DevotionalsRepository;
  audioStorage: AudioStorage;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => Date;
  signedUrlOptions?: SignedUrlOptions;
  logger?: SessionServiceLogger;
  /**
   * F8 Gloo engagement summary deps (issue #86) — all optional so callers
   * that don't care about this (e.g. `sessionSecurity.integration.test.ts`,
   * `audio.integration.test.ts`) don't need to construct them. When any is
   * missing, `completeSession` simply skips the summary step.
   */
  dailyBands?: DailyBandsRepository;
  glooSummaryService?: GlooSummaryService;
  glooEngagementSummaries?: GlooEngagementSummariesRepository;
  /**
   * Prayer intentions (docs/14 §5.5, issue #93) — optional so callers that
   * don't care about this feature don't need to construct it. When
   * missing, `completeSession` simply skips recording the intention even
   * if one was submitted.
   */
  prayerIntentions?: PrayerIntentionsRepository;
  /**
   * Session feedback (EPIC P #312, stories #320/#321) — optional like the
   * other feature deps so existing callers/tests don't need to construct
   * it. When missing, `recordFeedback` accepts-and-drops (same posture as
   * `prayerIntentions`: the public flow must never error because an
   * optional feature wasn't wired) and the completion page simply always
   * shows the form.
   */
  sessionFeedback?: SessionFeedbackRepository;
}

export class SessionService {
  private readonly sessions: SessionsRepository;
  private readonly devotionals: DevotionalsRepository;
  private readonly audioStorage: AudioStorage;
  private readonly now: () => Date;
  private readonly signedUrlOptions: SignedUrlOptions | undefined;
  private readonly logger: SessionServiceLogger;
  private readonly dailyBands: DailyBandsRepository | undefined;
  private readonly glooSummaryService: GlooSummaryService | undefined;
  private readonly glooEngagementSummaries: GlooEngagementSummariesRepository | undefined;
  private readonly prayerIntentions: PrayerIntentionsRepository | undefined;
  private readonly sessionFeedback: SessionFeedbackRepository | undefined;

  constructor(deps: SessionServiceDeps) {
    this.sessions = deps.sessions;
    this.devotionals = deps.devotionals;
    this.audioStorage = deps.audioStorage;
    this.now = deps.now ?? (() => new Date());
    this.signedUrlOptions = deps.signedUrlOptions;
    this.logger = deps.logger ?? consoleLogger;
    this.dailyBands = deps.dailyBands;
    this.glooSummaryService = deps.glooSummaryService;
    this.glooEngagementSummaries = deps.glooEngagementSummaries;
    this.prayerIntentions = deps.prayerIntentions;
    this.sessionFeedback = deps.sessionFeedback;
  }

  /**
   * Renders the data needed for the session page, or `not_found` for any
   * of: no such token, expired token (whether or not it has been purged
   * yet), or a devotional row that has vanished (defensive — should not
   * happen given the FK, but a dangling session must never 500 the join
   * link, Architecture §4 "the link never 404s [for generation failures]"
   * — that principle extends to "never dead-ends the user either").
   *
   * Also records `joined_at` (issue #84 — join-rate metrics per PRD §8
   * "60% of placed devotionals joined" require a join to actually be
   * recorded somewhere). `markJoined` is idempotent (`WHERE joined_at IS
   * NULL`), so re-opening the same link never overwrites the first join
   * time. This write is a metrics side effect, not part of the render
   * contract: a failure here is logged but never turns a successful page
   * view into an error response.
   */
  async getSessionView(token: string): Promise<SessionLookupResult> {
    const result = await this.loadPageView(token, { markJoined: true });
    return result.kind === 'ok' ? { kind: 'ok', page: result.page } : result;
  }

  /**
   * Read-only lookup for the Stage page (Q2 #332): identical token
   * validation, expiry collapse, and page data as `getSessionView`, but it
   * NEVER writes `joined_at`. The Stage URL is loaded by Attendee's bot
   * container (Q5), so counting its page load as a join would silently
   * corrupt Epic P's attendance signals — every bot-delivered devotional
   * would look "joined" whether or not the human showed up.
   *
   * Also loads the Q1 timing manifest (best-effort, null on any failure —
   * the page degrades to no-captions, same posture as `audioUrl`).
   */
  async getStageView(token: string): Promise<StageLookupResult> {
    const result = await this.loadPageView(token, { markJoined: false });
    if (result.kind !== 'ok') {
      return result;
    }

    let manifest: TimingManifest | null = null;
    try {
      manifest = await this.audioStorage.getManifest(result.devotionalId);
    } catch {
      manifest = null;
    }

    return { kind: 'ok', page: result.page, manifest, slotType: result.slotType };
  }

  /**
   * Shared loader behind `getSessionView` (marks joined) and
   * `getStageView` (read-only). The `markJoined` write is a metrics side
   * effect, not part of the render contract: a failure there is logged
   * but never turns a successful page view into an error response.
   */
  private async loadPageView(
    token: string,
    options: { markJoined: boolean },
  ): Promise<
    | { kind: 'not_found' }
    | { kind: 'ok'; page: SessionPageData; devotionalId: string; slotType: SlotType }
  > {
    const session = await this.sessions.findByToken(token);
    if (!session) {
      return { kind: 'not_found' };
    }
    if (session.expires_at.getTime() <= this.now().getTime()) {
      return { kind: 'not_found' };
    }

    const ownerId = asVerifiedUserId(session.user_id);

    if (options.markJoined) {
      try {
        await this.sessions.markJoined(ownerId, token);
      } catch (err) {
        this.logger.error('markJoined failed — continuing with page render', {
          token,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const devotional = await this.devotionals.getById(ownerId, session.devotional_id);
    if (!devotional) {
      return { kind: 'not_found' };
    }

    let audioUrl: string | null = null;
    if (devotional.audio_object) {
      try {
        const exists = await this.audioStorage.exists(devotional.id);
        if (exists) {
          const signed = await this.audioStorage.getSignedUrl(devotional.id, this.signedUrlOptions);
          audioUrl = signed.url;
        }
      } catch {
        // AUDIO_UNAVAILABLE (Foundation §4.5): degrade to transcript-first
        // rather than failing the whole page render.
        audioUrl = null;
      }
    }

    return {
      kind: 'ok',
      devotionalId: devotional.id,
      // The column is NOT NULL DEFAULT 'standard' (issue #77), so the
      // fallback only guards fakes/fixtures that predate the field —
      // an unknown slot must select the LIGHT (default) variant, never
      // throw or render dark by accident.
      slotType: devotional.slot_type === 'examen' ? 'examen' : 'standard',
      page: {
        token: session.token,
        completed: session.completed_at !== null,
        audioUrl,
        devotional: {
          theme: devotional.theme,
          format: devotional.format,
          verses: devotional.verses.map((v) => ({
            usfm: v.usfm,
            reference: v.reference,
            fetchedText: v.fetchedText,
            attribution: v.attribution,
          })),
          devotionalBody: devotional.devotional_body,
          prayer: devotional.prayer,
          journalingPrompt: devotional.journaling_prompt,
          actionStep: devotional.action_step,
        },
      },
    };
  }

  /**
   * Marks a session complete. Idempotent: a second call for an
   * already-completed session succeeds (same shape) without changing
   * `completed_at` again — "Amen" is a one-way door, not a toggle, and
   * double-submits (double-tap, retry after a flaky response) must not
   * reset the completion timestamp.
   *
   * On the genuine first completion, also fires the F8 Gloo engagement
   * summary (docs/03 §7, issue #86) — fire-and-forget, never awaited by
   * the caller and never allowed to affect this method's result — and
   * records the one-line prayer intention (docs/14 §5.5, issue #93), if
   * one was submitted, against this devotional. Both are first-completion-
   * only side effects: a retried/duplicate POST for an already-completed
   * session never re-runs them.
   */
  async completeSession(
    token: string,
    input: { durationListenedSec?: number | null; prayerIntention?: string | null } = {},
  ): Promise<SessionCompleteResult> {
    const session = await this.sessions.findByToken(token);
    if (!session) {
      return { kind: 'not_found' };
    }
    if (session.expires_at.getTime() <= this.now().getTime()) {
      return { kind: 'not_found' };
    }

    if (session.completed_at) {
      return { kind: 'ok', completedAt: session.completed_at };
    }

    const ownerId = asVerifiedUserId(session.user_id);
    const durationListenedSec = input.durationListenedSec ?? null;
    const updated = await this.sessions.markCompleted(ownerId, token, durationListenedSec);
    // updated should never be null here (we just confirmed the row exists
    // and derived ownerId from that same row), but guard defensively
    // rather than asserting non-null.
    const completedAt = updated?.completed_at ?? session.completed_at ?? this.now();

    if (updated) {
      // Not awaited — a summary failure must never affect the completion
      // response (docs/03 §7: "failures never affect the user").
      this.sendGlooSummary(ownerId, session.devotional_id, token, durationListenedSec).catch(
        (err) => {
          this.logger.error('sendGlooSummary failed — completion already recorded', {
            token,
            err: err instanceof Error ? err.message : String(err),
          });
        },
      );

      if (this.prayerIntentions && input.prayerIntention) {
        this.prayerIntentions.record(ownerId, session.devotional_id, input.prayerIntention).catch(
          (err) => {
            this.logger.error('prayerIntentions.record failed — completion already recorded', {
              token,
              err: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
    }

    return { kind: 'ok', completedAt };
  }

  /**
   * Records end-of-session feedback (P1 #320). Gates, in order:
   *  - unknown/expired token → `not_found` (identical to every other
   *    session route — enumeration safety, docs/04 §5.4);
   *  - never-joined session → `not_joined`. Joined, NOT completed, is the
   *    bar (#320: "someone can give feedback without tapping Amen") —
   *    `joined_at` is set on first page open, so anyone who actually saw
   *    the devotional passes.
   *
   * Upsert semantics (one row per session, per-column COALESCE) live in
   * SessionFeedbackRepository.upsert. Unlike the prayer-intention write
   * this is AWAITED, not fire-and-forget: the caller 303-redirects the
   * browser to the completion page, which immediately re-reads this row
   * to decide form-vs-thanked — a race there would re-show the form
   * right after the user sent feedback, exactly the double-ask #321's
   * "never nag twice" rule forbids.
   */
  async recordFeedback(token: string, input: SessionFeedbackBody): Promise<SessionFeedbackResult> {
    const session = await this.sessions.findByToken(token);
    if (!session) {
      return { kind: 'not_found' };
    }
    if (session.expires_at.getTime() <= this.now().getTime()) {
      return { kind: 'not_found' };
    }
    if (!session.joined_at) {
      return { kind: 'not_joined' };
    }

    if (this.sessionFeedback) {
      const ownerId = asVerifiedUserId(session.user_id);
      await this.sessionFeedback.upsert(ownerId, {
        sessionToken: session.token,
        devotionalId: session.devotional_id,
        contentHelpful: input.contentHelpful,
        topicMore: input.topicMore,
        lengthFeel: input.lengthFeel,
        timeFeel: input.timeFeel,
        note: input.note,
      });
    }

    return { kind: 'ok' };
  }

  /**
   * Data for the post-Amen confirmation page (P2 #321): whether feedback
   * already exists decides form vs thanked state (grace: once submitted,
   * never re-asked). Deliberately lighter than `getSessionView` — no
   * devotional/audio load and no `markJoined` (arriving here means the
   * session page itself was already opened, or the caller skipped it via
   * the JSON API, in which case a synthetic "join" would be a false
   * attendance signal for the policy engine, #323).
   */
  async getCompletionView(token: string): Promise<SessionCompletionViewResult> {
    const session = await this.sessions.findByToken(token);
    if (!session) {
      return { kind: 'not_found' };
    }
    if (session.expires_at.getTime() <= this.now().getTime()) {
      return { kind: 'not_found' };
    }

    let feedbackSubmitted = false;
    if (this.sessionFeedback) {
      const ownerId = asVerifiedUserId(session.user_id);
      feedbackSubmitted =
        (await this.sessionFeedback.findBySessionToken(ownerId, session.token)) !== null;
    }

    return { kind: 'ok', token: session.token, feedbackSubmitted };
  }

  private async sendGlooSummary(
    ownerId: ReturnType<typeof asVerifiedUserId>,
    devotionalId: string,
    sessionToken: string,
    durationListenedSec: number | null,
  ): Promise<void> {
    if (!this.glooSummaryService) {
      return;
    }

    const devotional = await this.devotionals.getById(ownerId, devotionalId);
    if (!devotional) {
      return;
    }
    const firstVerse = devotional.verses[0];
    if (!firstVerse) {
      return;
    }

    const bandsRow = this.dailyBands
      ? await this.dailyBands.getForDate(ownerId, devotional.date)
      : null;

    const summary: GlooEngagementSummary = {
      date: devotional.date,
      bands: {
        recovery: bandsRow?.recovery ?? null,
        sleepQuality: bandsRow?.sleep_quality ?? null,
        activity: bandsRow?.activity ?? null,
        busyness: bandsRow?.busyness ?? null,
        communicationLoad: bandsRow?.communication_load ?? null,
      },
      format: devotional.format,
      theme: devotional.theme,
      passage_usfm: firstVerse.usfm,
      versionId: firstVerse.versionId,
      completed: true,
      durationListenedSec,
    };

    await this.glooSummaryService.send(summary);

    if (this.glooEngagementSummaries) {
      await this.glooEngagementSummaries.record(ownerId, {
        devotionalId,
        sessionToken,
        payload: summary,
      });
    }
  }
}
