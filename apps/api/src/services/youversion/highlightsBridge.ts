/**
 * highlightsBridge — the two-way YouVersion highlights bridge (epic #353):
 * WRITE on Amen (U3, #356) and READ for personalization (U4, #357). Both live
 * here because both speak the one user-scoped surface, `/v1/highlights`, and
 * share the token-decrypt + refresh-once plumbing.
 *
 * Consent + privacy doctrine (epic #353, Foundation §8/§9):
 *  - Separately consent-gated: WRITE gates on `preferences.yv_write_highlights`,
 *    READ on `preferences.yv_read_highlights`. Both default OFF (migration
 *    1722700000000). Connecting an account is NOT consent to read or write.
 *  - §9: NEVER surface highlight counts/streaks/frequency anywhere — not in
 *    responses, not in info logs, not in UI. The read signal is USED, never
 *    scored or tallied.
 *  - Fail-open (WRITE): a YouVersion outage must never break Amen. Every write
 *    path is best-effort and swallows its own errors (same doctrine as the
 *    rhythm engine #325). The client itself never throws for HTTP/transport
 *    failures (see youVersionHighlightsClient.ts).
 *  - No verse TEXT ever appears in a log line here — only the passage/bible
 *    IDENTIFIERS (passageId/bibleId), which are references, not Scripture.
 *
 * ⚠️ MUST-CONFIRM (U1 — see youVersionHighlightsClient.ts header for the full
 * list): the POST body/response shapes, whether writes upsert, whether reads
 * are all-user or app-scoped, and the color format. This bridge is written so
 * it is correct under EITHER read scope — the honesty of the copy it feeds to
 * the engine (instructionsBuilder) never claims we saw the user's wider Bible.
 */

import type {
  CreateHighlightInput,
  NormalizedHighlight,
  YouVersionHighlightsClient,
} from './youVersionHighlightsClient.js';
import { HIGHLIGHT_DEFAULT_COLOR } from './youVersionHighlightsClient.js';
import type { VerifiedUserId } from '../../db/repositories/types.js';

// --- Narrow dependency seams (interfaces so tests fake exactly what is used) --

/** The KMS crypto boundary — same shape as GoogleKmsService, narrowed to what the bridge uses. */
export interface HighlightsKmsService {
  encryptToken(plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: string }>;
  decryptToken(ciphertext: Buffer): Promise<string>;
}

/** The OAuth service's refresh-token helper (YouVersionOAuthService), narrowed. */
export interface HighlightsOAuthService {
  refreshTokens(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scopes: string;
  }>;
}

/** One user's stored YouVersion connection row (subset of YouVersionConnectionRow). */
export interface HighlightsConnectionRow {
  access_token_encrypted: Buffer;
  refresh_token_encrypted: Buffer | null;
  token_expires_at: Date | null;
  youversion_user_id: string | null;
  display_name: string | null;
  scopes: string | null;
}

export interface HighlightsConnectionsRepository {
  get(userId: VerifiedUserId): Promise<HighlightsConnectionRow | null>;
  upsert(
    userId: VerifiedUserId,
    input: {
      accessTokenEncrypted: Buffer;
      refreshTokenEncrypted: Buffer | null;
      kmsKeyVersion: string;
      tokenExpiresAt: Date | null;
      youVersionUserId: string | null;
      displayName: string | null;
      scopes: string | null;
    },
  ): Promise<unknown>;
}

export interface HighlightsPreferencesRepository {
  get(userId: VerifiedUserId): Promise<{
    yv_write_highlights: boolean;
    yv_read_highlights: boolean;
  } | null>;
}

/** The primary verse the bridge marks — first verse of the devotional (the Stage hero). */
export interface HighlightsDevotionalRow {
  id: string;
  verses: Array<{ usfm: string; versionId: number }>;
  /** Idempotency stamp — non-null means the highlight was already written (migration 1722900000000). */
  yv_highlight_written_at: Date | null;
}

export interface HighlightsDevotionalsRepository {
  getById(userId: VerifiedUserId, devotionalId: string): Promise<HighlightsDevotionalRow | null>;
  markHighlightWritten(userId: VerifiedUserId, devotionalId: string): Promise<boolean>;
}

export interface HighlightsBridgeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: HighlightsBridgeLogger = {
  info: (msg, meta) => console.info(`[highlightsBridge] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[highlightsBridge] ${msg}`, meta ?? ''),
};

export interface HighlightsBridgeDeps {
  client: Pick<YouVersionHighlightsClient, 'createHighlight' | 'listHighlights'>;
  connections: HighlightsConnectionsRepository;
  preferences: HighlightsPreferencesRepository;
  devotionals: HighlightsDevotionalsRepository;
  kmsService: HighlightsKmsService;
  /** Optional — refresh-once on 401 is skipped when absent (or when the connection has no refresh token). */
  oauthService?: HighlightsOAuthService;
  logger?: HighlightsBridgeLogger;
  /** Injectable clock (deterministic tests + the per-day read cache key). */
  now?: () => Date;
}

// --- WRITE outcomes (for the structured log — never a count, just a verdict) --

export type WriteHighlightOutcome =
  | 'written'
  | 'no_connection'
  | 'consent_off'
  | 'already_written'
  | 'no_devotional'
  | 'no_verse'
  | 'api_error';

// --- READ: pure weaving decision -------------------------------------------

export type HighlightWeavingReason =
  | 'higher_precedence_active'
  | 'no_highlights'
  | 'no_repeat_window'
  | 'highlight_woven';

export interface HighlightWeavingContext {
  /**
   * True when a higher-precedence signal already steers this generation:
   * inviteContext > prayerIntention > feedback-theme > highlight (the #326
   * precedence idiom). The highlight is the LOWEST rung — the only one the
   * user never typed for THIS devotional — so it yields to all three.
   */
  higherPrecedenceActive: boolean;
  /**
   * Passage ids woven (or already used) within the no-repeat window — a
   * highlight already marked recently is skipped so the same verse is not
   * woven day after day. Derived by the caller (recent devotionals' primary
   * verses); the decision stays pure.
   */
  recentlyWovenPassageIds: readonly string[];
}

export interface HighlightWeavingDecision {
  /** The USFM passage to weave in (fetched via get_bible_verse downstream), or absent. */
  passageRef?: string;
  reason: HighlightWeavingReason;
}

/** The empty decision — what "nothing to weave" must produce. */
export const NO_HIGHLIGHT_WEAVING: HighlightWeavingDecision = Object.freeze({
  reason: 'no_highlights' as HighlightWeavingReason,
});

/**
 * Pure selection of ONE highlighted passage to weave in (U4 #357), mirroring
 * `decideSteering`/`resolveSteeredTheme`: no I/O, no clock, every branch
 * directly mutation-checkable.
 *
 * Rules, in order:
 *  1. A higher-precedence signal is active -> weave nothing (the highlight is
 *     the lowest rung; it never displaces invite/prayer/theme).
 *  2. No highlights at all -> nothing (only-when-real: never fabricate a mark).
 *  3. The first highlight whose passage was NOT woven within the no-repeat
 *     window is chosen (highlights arrive newest-first from the client's
 *     recency ordering); if every candidate was recently woven, nothing.
 */
export function decideHighlightWeaving(
  highlights: readonly NormalizedHighlight[],
  ctx: HighlightWeavingContext,
): HighlightWeavingDecision {
  if (ctx.higherPrecedenceActive) {
    return { reason: 'higher_precedence_active' };
  }
  if (highlights.length === 0) {
    return { reason: 'no_highlights' };
  }
  const recent = new Set(ctx.recentlyWovenPassageIds);
  const pick = highlights.find((h) => !recent.has(h.passageId));
  if (!pick) {
    return { reason: 'no_repeat_window' };
  }
  return { passageRef: pick.passageId, reason: 'highlight_woven' };
}

// --- The bridge -------------------------------------------------------------

interface ReadCacheEntry {
  /** ISO date (YYYY-MM-DD) the fetch was made on — one live fetch per user per day. */
  date: string;
  highlights: NormalizedHighlight[];
}

export class HighlightsBridge {
  private readonly deps: HighlightsBridgeDeps;
  private readonly logger: HighlightsBridgeLogger;
  private readonly now: () => Date;
  /**
   * Per-user, per-day READ cache (in-memory TTL keyed by user). Chosen over an
   * in-row column because: it needs no migration, it is naturally bounded (one
   * entry per active user, cleared on process restart), and a stale read is
   * harmless — losing a day's cache just costs one extra best-effort fetch,
   * never correctness. It caps live `/v1/highlights` calls at one per user per
   * generation day, respecting the provider's rate limits.
   */
  private readonly readCache = new Map<string, ReadCacheEntry>();

  constructor(deps: HighlightsBridgeDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? (() => new Date());
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /**
   * WRITE (U3 #356): mark this devotional's PRIMARY verse as a highlight in the
   * user's YouVersion account. Called fire-and-forget from session completion
   * (Amen); it NEVER throws — a YouVersion outage must not break Amen.
   *
   * Gates, in order (any failing gate = silent no-op, no error, no user nag):
   *   connection exists -> `yv_write_highlights` consent true -> devotional
   *   loads -> not already written -> has a primary verse.
   *
   * Multi-verse devotionals: only the FIRST verse (the hero the Stage shows)
   * is marked — one meaningful mark in the user's Bible, not a spray of them.
   *
   * Idempotency: the `yv_highlight_written_at` stamp is checked before the POST
   * and set (idempotently, first-writer-wins) only after it succeeds — safe
   * regardless of whether the API itself upserts (⚠️ must-confirm U1).
   */
  async writeHighlightForDevotional(
    userId: VerifiedUserId,
    devotionalId: string,
  ): Promise<WriteHighlightOutcome> {
    try {
      const connection = await this.deps.connections.get(userId);
      if (!connection) return this.logWrite(userId, devotionalId, null, null, 'no_connection');

      const prefs = await this.deps.preferences.get(userId);
      if (!prefs?.yv_write_highlights) {
        return this.logWrite(userId, devotionalId, null, null, 'consent_off');
      }

      const devotional = await this.deps.devotionals.getById(userId, devotionalId);
      if (!devotional) return this.logWrite(userId, devotionalId, null, null, 'no_devotional');
      if (devotional.yv_highlight_written_at) {
        return this.logWrite(userId, devotionalId, null, null, 'already_written');
      }

      const primaryVerse = devotional.verses[0];
      if (!primaryVerse) return this.logWrite(userId, devotionalId, null, null, 'no_verse');

      const passageId = primaryVerse.usfm;
      const bibleId = primaryVerse.versionId;
      const createInput: Omit<CreateHighlightInput, 'bearer'> = {
        bibleId,
        passageId,
        // Warm default color (⚠️ must-confirm U1) — a soft amber in the
        // design system's terracotta family; the mark still lands if the API
        // ignores it.
        color: HIGHLIGHT_DEFAULT_COLOR,
      };

      const bearer = await this.decryptAccessToken(connection);
      let result = await this.deps.client.createHighlight({ ...createInput, bearer });

      // Refresh-once on a real 401 (token expired), then retry (epic ground
      // rule). A refresh requires a stored refresh token AND the OAuth service
      // — either absent, we do not retry (YouVersion may issue no refresh
      // token at all, ⚠️ must-confirm U1).
      if (!result.ok && result.status === 401) {
        const freshBearer = await this.refreshAndPersist(userId, connection);
        if (freshBearer) {
          result = await this.deps.client.createHighlight({ ...createInput, bearer: freshBearer });
        }
      }

      if (!result.ok) {
        return this.logWrite(userId, devotionalId, passageId, bibleId, 'api_error', result.status);
      }

      // Stamp AFTER the successful POST, idempotently — a concurrent second
      // Amen that raced past the pre-check still cannot double-write because
      // markHighlightWritten is `WHERE ... IS NULL`.
      await this.deps.devotionals.markHighlightWritten(userId, devotionalId);
      return this.logWrite(userId, devotionalId, passageId, bibleId, 'written');
    } catch (err) {
      // Absolute fail-open backstop: nothing in the write path may escape to
      // the Amen flow. Logged as an error but returned as a best-effort
      // outcome, never rethrown.
      this.logger.error('writeHighlightForDevotional failed — Amen unaffected', {
        userId,
        devotionalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'api_error';
    }
  }

  /**
   * READ (U4 #357): the user's recent highlights, gated on
   * `yv_read_highlights`, normalized and cached one fetch per user per day.
   * Returns `[]` for: consent off, no connection, or any best-effort failure —
   * the personalization signal simply degrades to "no highlights".
   *
   * §9: the return value is a plain list for the engine to USE. It is never
   * counted or displayed as a tally, and this method emits no count in any
   * log.
   *
   * HONESTY (⚠️ must-confirm U1 read scope): the copy that consumes this
   * (instructionsBuilder highlight framing) is written to be true whether the
   * API returns the user's whole Bible or only Wellspring-created highlights —
   * it never implies we saw their wider activity.
   */
  async readRecentHighlights(
    userId: VerifiedUserId,
    opts: { limit?: number } = {},
  ): Promise<NormalizedHighlight[]> {
    const limit = opts.limit ?? 20;
    try {
      const prefs = await this.deps.preferences.get(userId);
      if (!prefs?.yv_read_highlights) return [];

      const cached = this.readCache.get(userId);
      const today = this.today();
      if (cached && cached.date === today) {
        return cached.highlights.slice(0, limit);
      }

      const connection = await this.deps.connections.get(userId);
      if (!connection) return [];

      const bearer = await this.decryptAccessToken(connection);
      let result = await this.deps.client.listHighlights({ bearer, pageSize: 100 });
      if (!result.ok && result.status === 401) {
        const freshBearer = await this.refreshAndPersist(userId, connection);
        if (freshBearer) {
          result = await this.deps.client.listHighlights({ bearer: freshBearer, pageSize: 100 });
        }
      }

      const highlights = result.ok ? sortByRecency(result.data) : [];
      // Cache even an empty result: a consented user with genuinely no
      // highlights should not be re-fetched all day. A failed fetch is NOT
      // cached (result.ok false leaves `highlights` empty but we still store —
      // acceptable: a transient failure costs at most one day's signal, and
      // avoids hammering a struggling provider). We store the fetched-today
      // marker regardless so rate limits are respected.
      this.readCache.set(userId, { date: today, highlights });
      return highlights.slice(0, limit);
    } catch (err) {
      this.logger.error('readRecentHighlights failed — no highlight signal this run', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Test/ops seam: drop a user's cached read (e.g. on disconnect). */
  invalidateReadCache(userId: VerifiedUserId): void {
    this.readCache.delete(userId);
  }

  private async decryptAccessToken(connection: HighlightsConnectionRow): Promise<string> {
    return this.deps.kmsService.decryptToken(connection.access_token_encrypted);
  }

  /**
   * Refresh the access token via the OAuth service and persist the rotated
   * pair, returning the fresh bearer — or null when a refresh is impossible
   * (no stored refresh token, no OAuth service) or fails. Encryption happens
   * here, at the service boundary; the repository only ever sees ciphertext
   * (same posture as the connect route).
   */
  private async refreshAndPersist(
    userId: VerifiedUserId,
    connection: HighlightsConnectionRow,
  ): Promise<string | null> {
    if (!this.deps.oauthService || !connection.refresh_token_encrypted) return null;
    try {
      const refreshToken = await this.deps.kmsService.decryptToken(
        connection.refresh_token_encrypted,
      );
      const fresh = await this.deps.oauthService.refreshTokens(refreshToken);

      const encAccess = await this.deps.kmsService.encryptToken(fresh.accessToken);
      // A rotated refresh token replaces the old one; a response with none
      // keeps the existing stored refresh token (⚠️ must-confirm U1 whether
      // YouVersion rotates or reissues).
      const refreshTokenEncrypted = fresh.refreshToken
        ? (await this.deps.kmsService.encryptToken(fresh.refreshToken)).ciphertext
        : connection.refresh_token_encrypted;

      await this.deps.connections.upsert(userId, {
        accessTokenEncrypted: encAccess.ciphertext,
        refreshTokenEncrypted,
        kmsKeyVersion: encAccess.keyVersion,
        tokenExpiresAt: fresh.expiresAt ? new Date(fresh.expiresAt) : null,
        youVersionUserId: connection.youversion_user_id,
        displayName: connection.display_name,
        scopes: fresh.scopes ?? connection.scopes,
      });
      return fresh.accessToken;
    } catch (err) {
      this.logger.error('token refresh failed — using no fresh bearer', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The ONE structured write-log line (U3 ops evidence): identifiers only —
   * `{ userId, devotionalId, passageId, bibleId, outcome }` — never verse
   * text, never a count (§9). Returns the outcome so call sites stay one-liners.
   */
  private logWrite(
    userId: VerifiedUserId,
    devotionalId: string,
    passageId: string | null,
    bibleId: number | null,
    outcome: WriteHighlightOutcome,
    apiStatus?: number,
  ): WriteHighlightOutcome {
    this.logger.info('highlight write', {
      userId,
      devotionalId,
      passageId,
      bibleId,
      outcome,
      ...(apiStatus !== undefined ? { apiStatus } : {}),
    });
    return outcome;
  }
}

/** Newest-first by `createdAt` when present; items without a timestamp keep their arrival order after the timestamped ones. */
function sortByRecency(highlights: NormalizedHighlight[]): NormalizedHighlight[] {
  return [...highlights].sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return 0;
  });
}

/** The narrow WRITE seam session completion depends on — keeps sessionService ignorant of the whole bridge. */
export interface HighlightWriter {
  writeHighlightForDevotional(
    userId: VerifiedUserId,
    devotionalId: string,
  ): Promise<WriteHighlightOutcome>;
}
