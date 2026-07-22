/**
 * Reschedule watcher (EPIC C, issue #25): "the gap got booked -> move the
 * event." docs/02_ARCHITECTURE.md §3.3 sketches the intent ("calendar
 * webhook/poll detects the gap got booked... move event only — content
 * still valid, bands rarely shift mid-day"); this module implements the
 * poll-based half only.
 *
 * Deliberately NOT implemented here (see issue #25's tracking comment for
 * the rationale): the `events.watch` push-notification webhook half.
 * Registering a watch channel is a real, side-effecting call against a
 * user's live Google account (creates a subscription that must be renewed
 * before expiry and cleaned up), and Google's push payloads never carry
 * enough information to act on directly — a follow-up API call is always
 * required either way. The poll path below already needs that same
 * follow-up call (`getFreeBusyBlocks`), so it delivers the acceptance
 * criterion ("simulated conflict test") completely on its own; the webhook
 * would only shorten the detection latency between "gap booked" and
 * "event moved," not change what has to happen once detected.
 *
 * Reuses exactly the client-construction pattern
 * `GenerateNowOrchestrator.runCalendarStep()` already established:
 * `ConnectionsRepository.findByProvider` -> `GoogleKmsService.decryptToken`
 * -> `GoogleCalendarClient.withRefreshToken`.
 */
import { asVerifiedUserId } from '../../db/repositories/index.js';
import type {
  CalendarEventRow,
  CalendarEventsRepository,
} from '../../db/repositories/calendarEventsRepository.js';
import type { ConnectionsRepository } from '../../db/repositories/connectionsRepository.js';
import type { PreferencesRepository } from '../../db/repositories/preferencesRepository.js';
import type { UsersRepository } from '../../db/repositories/usersRepository.js';
import type { GoogleCalendarClient, FreeBusyBlock } from './googleCalendarClient.js';
import type { GoogleKmsService } from './googleKmsService.js';
import { analyzeBusyness } from '../busynessAnalyzer.js';
import { resolveSchedulingWindow, localCalendarDate } from './schedulingWindow.js';

export interface RescheduleWatcherLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: RescheduleWatcherLogger = {
  info: (msg, meta) => console.info(`[RescheduleWatcher] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[RescheduleWatcher] ${msg}`, meta ?? ''),
};

export interface RescheduleWatcherDeps {
  connections: ConnectionsRepository;
  calendarEvents: CalendarEventsRepository;
  preferences: PreferencesRepository;
  users: UsersRepository;
  calendarClient: GoogleCalendarClient;
  kmsService: GoogleKmsService;
  /** Injectable clock — "not yet passed" filtering runs off this, never `Date.now()` directly. */
  now?: () => Date;
  logger?: RescheduleWatcherLogger;
}

export interface RescheduleCheckResult {
  /** Future (not-yet-started) calendar_events rows examined across all users. */
  checked: number;
  /** Conflict detected, event successfully moved to a new gap. */
  moved: number;
  /** No conflict — the original gap is still free. */
  unchanged: number;
  /** Conflict detected, but no candidate gap was available to move to. */
  noGapAvailable: number;
  /** An error occurred while checking or moving a specific event. */
  failed: number;
  errors: Array<{ userId: string; providerEventId: string; reason: string }>;
}

/**
 * True exactly when `gap`'s window genuinely overlaps at least one of
 * `freshBusyBlocks` — "the gap got booked." Pure, no I/O; the single
 * source of truth for conflict detection, independent of whether a
 * same-sized gap happens to still exist elsewhere on the freshly analyzed
 * gap list (a coincidence this check deliberately does not rely on).
 */
export function detectGapConflict(
  gap: { start: string; end: string },
  freshBusyBlocks: FreeBusyBlock[],
): boolean {
  const gapStart = new Date(gap.start).getTime();
  const gapEnd = new Date(gap.end).getTime();
  return freshBusyBlocks.some((block) => {
    const blockStart = new Date(block.start).getTime();
    const blockEnd = new Date(block.end).getTime();
    return blockStart < gapEnd && blockEnd > gapStart;
  });
}

/**
 * Runs the reschedule check for exactly the given user ids (callers fan
 * out via `UsersRepository.listWithActiveGoogleCalendar()`, mirroring
 * `POST /internal/trigger-daily-run`'s existing pattern) — kept as a
 * parameter rather than looked up here so this function stays unit
 * testable without a real `users` list query.
 */
export async function runRescheduleCheck(
  deps: RescheduleWatcherDeps,
  userIds: string[],
): Promise<RescheduleCheckResult> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? consoleLogger;
  const result: RescheduleCheckResult = {
    checked: 0,
    moved: 0,
    unchanged: 0,
    noGapAvailable: 0,
    failed: 0,
    errors: [],
  };

  for (const rawUserId of userIds) {
    const userId = asVerifiedUserId(rawUserId);

    const connection = await deps.connections.findByProvider(userId, 'google_calendar');
    if (!connection || connection.status !== 'active') {
      continue; // No live calendar to check against — nothing to reschedule.
    }

    const allEvents = await deps.calendarEvents.listForUser(userId);
    const futureEvents = allEvents.filter((row) => row.gap_start_at.getTime() > now().getTime());
    if (futureEvents.length === 0) continue;

    const user = await deps.users.findById(userId);
    const prefs = await deps.preferences.get(userId);

    // Consent gate (issue #201, Foundation §8). This is the *second* free/busy
    // read in the system — `generateNowOrchestrator.runCalendarStep` is the
    // other — and it runs on its own Cloud Scheduler cadence (every ~15 min),
    // independent of generation. Gating only the orchestrator would leave a
    // user who revoked calendar access still having their free/busy polled
    // four times an hour, which is precisely the "the toggle did nothing"
    // failure #201 exists to fix.
    //
    // Placed before `decryptToken` so a revoked user's OAuth credential is
    // never unwrapped, matching the orchestrator's gate placement.
    //
    // Existing future events are deliberately left on the calendar rather
    // than deleted: revoking consent stops Wellspring *reading* the calendar, and
    // silently deleting events the user can see is a destructive act they did
    // not ask for. They remain removable by hand, and "Disconnect calendar"
    // on the Data & Privacy screen is the path for tearing down the
    // connection itself.
    const calendarEnabled = prefs?.calendar_enabled ?? true;
    if (!calendarEnabled) {
      logger.info('calendar_enabled is false — skipping reschedule check for user', {
        userId: rawUserId,
      });
      continue;
    }

    const tz = user?.timezone ?? 'UTC';
    const windowStart = prefs?.window_start_local ?? '07:00:00';
    const windowEnd = prefs?.window_end_local ?? '09:00:00';

    let refreshToken: string;
    try {
      refreshToken = await deps.kmsService.decryptToken(connection.encrypted_refresh_token);
    } catch (err) {
      logger.error('Failed to decrypt refresh token — skipping user', { userId: rawUserId, reason: String(err) });
      result.failed += futureEvents.length;
      for (const row of futureEvents) {
        result.errors.push({ userId: rawUserId, providerEventId: row.provider_event_id, reason: String(err) });
      }
      continue;
    }
    const userCalendarClient = deps.calendarClient.withRefreshToken(refreshToken);

    for (const row of futureEvents) {
      result.checked++;
      try {
        await checkAndRescheduleOne(userCalendarClient, deps.calendarEvents, userId, row, tz, windowStart, windowEnd, logger, result);
      } catch (err) {
        result.failed++;
        result.errors.push({ userId: rawUserId, providerEventId: row.provider_event_id, reason: String(err) });
        logger.error('Reschedule check failed for event', {
          userId: rawUserId,
          providerEventId: row.provider_event_id,
          reason: String(err),
        });
      }
    }
  }

  return result;
}

async function checkAndRescheduleOne(
  client: GoogleCalendarClient,
  calendarEvents: CalendarEventsRepository,
  userId: ReturnType<typeof asVerifiedUserId>,
  row: CalendarEventRow,
  tz: string,
  windowStartLocal: string,
  windowEndLocal: string,
  logger: RescheduleWatcherLogger,
  result: RescheduleCheckResult,
): Promise<void> {
  // Re-derive the same wall-clock day-window the original insert used
  // (preferences window, on the gap's own calendar date), so the fresh gap
  // search covers the same scheduling day the event actually lives on.
  //
  // #205: this carried *two* instances of the wall-clock-meets-UTC-Date defect,
  // and both had to go or the reschedule path would fight the insert path.
  //
  //  1. `toISOString().slice(0, 10)` is the **UTC** date of the gap, not the
  //     user's. A Sydney user's 07:00 gap on Jan 15 is 20:00Z on Jan *14*, so
  //     the watcher rebuilt the window for the previous local day and searched
  //     a day the event was never on.
  //  2. `setUTCHours` then read the local wall clock as UTC — the #205 defect
  //     proper, copied here independently of the orchestrator.
  //
  // Both now route through schedulingWindow.ts, the single place these two
  // types are allowed to meet, so the paths cannot drift apart again.
  const gapDateStr = localCalendarDate(row.gap_start_at, tz);
  const windowBounds = resolveSchedulingWindow({
    date: gapDateStr,
    windowStartLocal,
    windowEndLocal,
    timeZone: tz,
  });

  // A window erased by a spring-forward gap has nothing to search, and an
  // inverted range is a 400 from freeBusy. Leave the event alone rather than
  // counting a failure: it is still on the user's calendar and untouched.
  if (windowBounds.degenerate) {
    result.unchanged++;
    logger.info('Scheduling window does not exist on this date (DST transition) — event left as-is', {
      userId,
      providerEventId: row.provider_event_id,
      date: gapDateStr,
      timezone: windowBounds.timeZone,
    });
    return;
  }

  const { timeMin, timeMax } = windowBounds;

  // As in the orchestrator, downstream calls use the zone the bounds were
  // actually resolved in so interpretation can never disagree with the window.
  const freshBusyBlocks = await client.getFreeBusyBlocks({
    timeMin,
    timeMax,
    timeZone: windowBounds.timeZone,
  });

  const originalGap = { start: row.gap_start_at.toISOString(), end: row.gap_end_at.toISOString() };
  if (!detectGapConflict(originalGap, freshBusyBlocks)) {
    result.unchanged++;
    return;
  }

  const analysis = analyzeBusyness({ start: timeMin, end: timeMax, timeZone: windowBounds.timeZone }, freshBusyBlocks);
  const newGap = analysis.gaps[0];
  if (!newGap) {
    result.noGapAvailable++;
    logger.info('Gap booked, but no alternative gap available — event left as-is', {
      userId,
      providerEventId: row.provider_event_id,
    });
    return;
  }

  await client.patchEvent(row.provider_event_id, {
    startDateTime: newGap.start,
    endDateTime: newGap.end,
    timeZone: windowBounds.timeZone,
  });
  await calendarEvents.recordReschedule(
    userId,
    row.provider_event_id,
    new Date(newGap.start),
    new Date(newGap.end),
  );
  result.moved++;
  logger.info('Moved event to a new gap after conflict', {
    userId,
    providerEventId: row.provider_event_id,
    newGapStart: newGap.start,
  });
}
