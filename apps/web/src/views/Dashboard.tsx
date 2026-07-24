/**
 * The signed-in home (L1 #237, and the surface every other L story lands
 * on).
 *
 * ## Order: presence outranks archive
 *
 * today → "+" → upcoming → invite address → past devotionals + search →
 * recap, then connection and coming-soon. #237 fixes this order across
 * both surfaces, and the reasoning is that a dashboard which opens with an
 * archive is a dashboard about the past. What is happening now, and next,
 * comes first.
 *
 * ## Every card owns its own fetch
 *
 * There is no aggregate load and no page-level spinner. Each card calls
 * `useCardData` with its own loader, so one endpoint failing degrades one
 * card (#237, #245). The only thing fetched at this level is the
 * preferences payload — already loaded by the shell before this view
 * renders — because two cards need `activeDays` and `inviteAddress` and
 * re-fetching it per card would be three calls for one answer.
 *
 * ## First run (#245)
 *
 * A brand-new user's dashboard is *entirely* empty states, and #245 asks
 * for that to read as one orienting screen rather than six apologies. The
 * `firstRun` banner is that screen's opening sentence: when nothing has
 * happened yet, the page says what will appear here and points at the two
 * things the user can do right now (make one, or connect a calendar).
 * Each card's own empty copy then completes the picture in place, so the
 * orientation is distributed rather than stacked into a wall of text.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  DevotionalCard,
  LiturgicalSeason,
  PreferencesResponseData,
} from '@kairos/shared-contracts';
import { getConnections, getRecap, getUpcomingEvents } from '../api/dashboard';
import { getDevotional, getDevotionals, searchDevotionals } from '../api/devotionals';
import { getLiturgicalSeason } from '../api/liturgy';
import { useCardData } from '../hooks/useCardData';
import { emptyCard, readyCard, type CardState } from '../lib/cardState';
import {
  deriveConnectionState,
  schedulingCapability,
  type ConnectionState,
} from '../lib/connectionState';
import { resolveZone } from '../lib/datetime';
import { appendPage, firstPage, EMPTY_HISTORY, type HistoryPage } from '../lib/history';
import { deriveTodayState, type TodayState } from '../lib/todayCard';
import { hourFromLocalTime } from '../lib/preferences';
import { returnGreeting } from '../lib/returnGreeting';
import { anchorForToday, primaryVerse } from '../lib/scripture';
import { emptyUpcomingMessage } from '../lib/upcoming';
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import { CardFrame } from '../components/dashboard/CardFrame';
import {
  CalendarCard,
  type KairosKnowledge,
} from '../components/dashboard/calendar/CalendarCard';
import { ComingSoonCards } from '../components/dashboard/ComingSoonCards';
import { ConnectionCardBody } from '../components/dashboard/ConnectionCardBody';
import { GenerateNowButton } from '../components/dashboard/GenerateNowButton';
import type { GenerateOutcome } from '../lib/generateNow';
import { HistoryCardBody } from '../components/dashboard/HistoryCard';
import { InviteAddressCard } from '../components/dashboard/InviteAddressCard';
import { JournalCard } from '../components/dashboard/JournalCard';
import { RecapCardBody, recapTitle } from '../components/dashboard/RecapCardBody';
import { TodayCardBody, type TodayScripture } from '../components/dashboard/TodayCard';
import { UpcomingList } from '../components/dashboard/UpcomingList';

/**
 * A single common letter — enough to be a valid query for any plausible
 * validation, and cheap for the server to answer. Its *results* are
 * discarded; only whether the route exists is read.
 */
const SEARCH_PROBE_QUERY = 'a';

export function DashboardView({
  preferences,
  browserZone,
  onOpenDevotional,
  onOpenSettings,
  onConnectCalendar,
  now = () => new Date(),
}: {
  preferences: PreferencesResponseData;
  browserZone: string;
  onOpenDevotional: (id: string, note?: string) => void;
  onOpenSettings: () => void;
  onConnectCalendar: () => void;
  /** Injectable so the composition can be exercised at a fixed instant. */
  now?: () => Date;
}) {
  /*
   * The server's own zone for this user (`users.timezone`), now echoed on
   * `GET /v1/preferences`. Until that field existed this was necessarily
   * `undefined` and every time fell back to the browser's guess — which
   * silently disagrees with the schedule the moment someone travels, and
   * disagreeing about the hour is the entire substance of #205.
   *
   * `resolveZone` still takes the browser zone so it can detect and
   * surface that mismatch rather than quietly picking a winner.
   */
  const zoneInfo = resolveZone(preferences.timezone, browserZone);
  const zone = zoneInfo.zone;

  const [history, setHistory] = useState<HistoryPage>(EMPTY_HISTORY);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchResults, setSearchResults] = useState<readonly DevotionalCard[] | null>(null);
  const [searchAvailable, setSearchAvailable] = useState(false);
  const [searching, setSearching] = useState(false);

  // --- cards ----------------------------------------------------------

  const historyCard = useCardData<HistoryPage>(
    useCallback(async () => {
      const page = firstPage(await getDevotionals(null));
      setHistory(page);
      return page.items.length === 0 ? emptyCard<HistoryPage>() : readyCard(page);
    }, []),
    [],
  );

  const upcomingCard = useCardData<readonly UpcomingCalendarEvent[]>(
    useCallback(async () => {
      const events = await getUpcomingEvents();
      return events.length === 0
        ? emptyCard<readonly UpcomingCalendarEvent[]>()
        : readyCard(events);
    }, []),
    [],
  );

  const connectionCard = useCardData<ConnectionState>(
    useCallback(async () => readyCard(deriveConnectionState(await getConnections())), []),
    [],
  );

  /*
   * The recap is for the month that has *finished*. Asking for the current
   * month mid-month would narrate an incomplete story, and #96 builds the
   * narrative from a whole month's material.
   */
  const recapMonth = (() => {
    const current = now();
    const year = current.getFullYear();
    const month = current.getMonth(); // 0-based; last month, 1-based, is this value.
    return month === 0 ? { year: year - 1, month: 12 } : { year, month };
  })();

  const recapCard = useCardData(
    useCallback(async () => {
      const recap = await getRecap(recapMonth.year, recapMonth.month);
      /*
       * `sessionsCount` decides whether there is a month to narrate — a
       * threshold, never a display. See RecapCardBody for why no count
       * reaches the screen.
       */
      if (recap.sessionsCount === 0) return emptyCard<typeof recap>();
      return readyCard(recap);
    }, [recapMonth.year, recapMonth.month]),
    [recapMonth.year, recapMonth.month],
  );

  /*
   * What the calendar view is allowed to claim about Wellspring's own slots.
   *
   * `empty` is knowledge — the endpoint answered and there is nothing
   * booked. `error` and `loading` are not, and collapsing them to `[]`
   * would draw a calendar asserting Wellspring has booked nothing, which is
   * the same shape of lie as rendering a revoked calendar as free.
   */
  const kairosKnowledge: KairosKnowledge =
    upcomingCard.state.status === 'ready'
      ? { kind: 'known', events: upcomingCard.state.data }
      : upcomingCard.state.status === 'empty'
        ? { kind: 'known', events: [] }
        : { kind: 'unknown' };

  /*
   * Today is composed from two cards' data rather than fetched. It is
   * `loading` only while both sources are still loading, so a failure of
   * one does not hold the card hostage — and if both fail it reports the
   * error rather than claiming an empty day.
   */
  const todayState: CardState<TodayState> = (() => {
    const devotionals =
      historyCard.state.status === 'ready'
        ? historyCard.state.data.items
        : historyCard.state.status === 'empty'
          ? []
          : null;
    const events =
      upcomingCard.state.status === 'ready'
        ? upcomingCard.state.data
        : upcomingCard.state.status === 'empty'
          ? []
          : null;

    if (devotionals === null && events === null) {
      if (historyCard.state.status === 'error' && upcomingCard.state.status === 'error') {
        return { status: 'error', message: 'Wellspring could not load today.' };
      }
      return { status: 'loading' };
    }

    return readyCard(
      deriveTodayState({
        devotionals: devotionals ?? [],
        events: events ?? [],
        now: now(),
        zone,
      }),
    );
  })();

  /*
   * ## The season (N10, #269)
   *
   * Its own fetch, and deliberately not folded into the Today card's
   * composition: the card must render whether or not this answers. A
   * failed or slow season lookup that could blank the Today card would
   * make the smallest addition on the page the most dangerous thing on it.
   *
   * `null` — the season does not inform this user's devotionals — and a
   * failure both render as no line. That collapse is intentional: there is
   * no "we could not load the church year" state worth showing anyone.
   */
  const [season, setSeason] = useState<LiturgicalSeason | null>(null);
  useEffect(() => {
    let live = true;
    getLiturgicalSeason()
      .then((value) => {
        if (live) setSeason(value);
      })
      .catch(() => {
        if (live) setSeason(null);
      });
    return () => {
      live = false;
    };
  }, []);

  /*
   * ## Scripture on the Today card (N2, #261)
   *
   * Two steps, and the split is the point. `anchorForToday` decides which
   * devotional's passage belongs on the card and what may be claimed about
   * it (`lib/scripture.ts`); this effect only fetches it.
   *
   * Keyed on the anchor's id so it re-runs when today's devotional appears
   * — a user who presses "+" and comes back must see the new passage, not
   * yesterday's. Like the season above it degrades to silence rather than
   * to an error state: the Today card without a verse is the card as it
   * shipped, which is a worse card but not a broken one.
   */
  const anchor =
    todayState.status === 'ready'
      ? anchorForToday(
          todayState.data,
          historyCard.state.status === 'ready' ? historyCard.state.data.items : [],
        )
      : null;
  const [scripture, setScripture] = useState<TodayScripture | null>(null);
  const anchorId = anchor?.devotionalId ?? null;
  const anchorProvenance = anchor?.provenance ?? null;
  useEffect(() => {
    if (anchorId === null || anchorProvenance === null) {
      setScripture(null);
      return;
    }
    let live = true;
    getDevotional(anchorId)
      .then((devotional) => {
        const verse = primaryVerse(devotional.verses);
        if (live) setScripture(verse ? { verse, provenance: anchorProvenance } : null);
      })
      .catch(() => {
        if (live) setScripture(null);
      });
    return () => {
      live = false;
    };
  }, [anchorId, anchorProvenance]);

  /*
   * ## Probing for search (L6, #242 — not yet merged)
   *
   * The search box renders only if the endpoint answers. One cheap probe
   * on mount decides: a 404 (`searchDevotionals` returns `null`) means
   * this deployment has no search route, and the control is never drawn.
   *
   * Failing *closed* is deliberate. Any other outcome — a 400 from
   * validation this client guessed wrong about, a 500, a network blip —
   * also hides the control, because the alternative is a search box that
   * throws on submit, which is exactly the "renders but does nothing"
   * shape docs/05 P7 forbids. A hidden-but-working search is a missing
   * feature; a visible-but-broken one is a lie.
   */
  useEffect(() => {
    let live = true;
    searchDevotionals(SEARCH_PROBE_QUERY)
      .then((result) => {
        if (live && result !== null) setSearchAvailable(true);
      })
      .catch(() => {
        if (live) setSearchAvailable(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // --- first run ------------------------------------------------------

  /*
   * "Nothing has happened yet" — not "a fetch failed". Both cards must
   * have *successfully* reported emptiness, which is exactly the
   * distinction #245 draws (a failed pull is never an empty state).
   */
  const firstRun =
    historyCard.state.status === 'empty' && upcomingCard.state.status === 'empty';

  /*
   * The return greeting (N13, #282 — the #271 ruling made real).
   *
   * Grace notices, and does not charge: after a gap Wellspring says a warm
   * word and no number. The signal is the newest devotional's date and
   * nothing else — deliberately not routed through `deriveTodayState`,
   * which stays blind to history so a streak remains uncomputable there
   * (its docstring). `returnGreeting` returns a fixed sentence or `null`;
   * it cannot carry a count. Mutually exclusive with `firstRun` by
   * construction: a first-run user has no devotional date, so the greeting
   * is `null` and the welcome banner shows instead.
   */
  const mostRecentDevotionalDate =
    historyCard.state.status === 'ready' ? (historyCard.state.data.items[0]?.date ?? null) : null;
  const greeting = returnGreeting(mostRecentDevotionalDate, now(), zone);

  /*
   * Whether to lead with the connect action (N7, #266).
   *
   * For a user with no working calendar, connecting one is the single
   * action that turns everything else on — so the connection card moves
   * to the top, above Today, rather than sitting tenth. It is the SAME
   * card in a different position, not a second copy: rendered here or at
   * the bottom, never both, so `never`/`revoked` keep their distinct copy
   * and there is no duplicated control.
   *
   * Keyed on `schedulingCapability`, which is `'disconnected'` only for a
   * genuinely `ready` never/revoked state — a `loading` or `error`
   * connection card is `'unknown'` and stays at the bottom, because
   * promoting a spinner to the top of the page is not leading with an
   * action. A `'connected'` user is `false` here, so their dashboard is
   * untouched by this story.
   */
  const leadWithConnect = schedulingCapability(connectionCard.state) === 'disconnected';

  const connectionCardFrame = (
    <CardFrame
      id="connection"
      title="Calendar"
      state={connectionCard.state}
      onRetry={connectionCard.reload}
      emptyMessage={<p className="hint">No calendar is connected.</p>}
    >
      {(state) => <ConnectionCardBody state={state} zone={zone} onConnect={onConnectCalendar} />}
    </CardFrame>
  );

  // --- actions --------------------------------------------------------

  async function showMore() {
    if (!history.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = appendPage(history, await getDevotionals(history.nextCursor));
      setHistory(next);
    } catch {
      // The already-rendered rows stay. A failed *additional* page is not
      // a reason to discard the archive the user is reading.
    } finally {
      setLoadingMore(false);
    }
  }

  async function runSearch(query: string) {
    setSearching(true);
    try {
      const result = await searchDevotionals(query);
      if (result === null) {
        // The endpoint is not deployed. Hide the control rather than leave
        // a box that fails on every submit (docs/05 P7).
        setSearchAvailable(false);
        setSearchResults(null);
        return;
      }
      setSearchResults(result.data);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handleGenerated(outcome: GenerateOutcome) {
    onOpenDevotional(outcome.devotionalId, outcome.note ?? undefined);
  }

  // --- render ---------------------------------------------------------

  return (
    <>
      <header className="dash-header">
        {/*
         * The brand lockup (§05): 34px terracotta-gradient circle +
         * Spectral wordmark. The mark is decoration — `aria-hidden` keeps
         * the heading's accessible name exactly "Wellspring".
         */}
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Wellspring
        </h1>
        <nav aria-label="Sections">
          <button type="button" className="quiet" onClick={onOpenSettings}>
            Settings
          </button>
        </nav>
      </header>

      {/*
       * Grace notices, and does not charge (#282). A warm standing
       * invitation after a gap — never a count of the gap. `role="status"`
       * so a returning screen-reader user hears it, `.notice` (neutral,
       * not warn/error) because it is a welcome, not a warning.
       */}
      {greeting && (
        <p className="notice" role="status">
          {greeting}
        </p>
      )}

      {firstRun && (
        <section aria-labelledby="first-run-heading" className="card dash-card">
          <h2 id="first-run-heading">Welcome to Wellspring</h2>
          <p className="lede">
            This is where your devotionals will live — today’s at the top, what’s coming next below
            it, and everything you’ve sat with after that.
          </p>
          <p className="hint">
            Wellspring books devotionals into the open moments on your calendar. You don’t have to do
            anything to make that happen — but you can make one right now with the “+” whenever you
            want.
          </p>
        </section>
      )}

      {zoneInfo.travelling && (
        <p className="notice notice-warn" role="status">
          Times below are shown in {zoneInfo.zone}, which is where Wellspring schedules you. Your browser
          is in {zoneInfo.browserZone}.
        </p>
      )}

      {/*
       * Lead with connect (#266). A disconnected user meets the one action
       * that makes the product work before anything that depends on it.
       * When connected, this is `false` and the card renders in its
       * original position at the bottom instead — see the end of this list.
       */}
      {leadWithConnect && connectionCardFrame}

      <CardFrame
        id="today"
        title="Today"
        state={todayState}
        onRetry={() => {
          historyCard.reload();
          upcomingCard.reload();
        }}
        emptyMessage={<p className="hint">Nothing is scheduled for today.</p>}
        headerAction={<GenerateNowButton onGenerated={handleGenerated} />}
      >
        {(state) => (
          <TodayCardBody
            state={state}
            zone={zone}
            onOpenDevotional={(id) => onOpenDevotional(id)}
            season={season}
            scripture={scripture}
          />
        )}
      </CardFrame>

      <CardFrame
        id="upcoming"
        title="Coming up"
        state={upcomingCard.state}
        onRetry={upcomingCard.reload}
        emptyMessage={
          <p className="hint">
            {emptyUpcomingMessage(
              preferences.activeDays,
              now(),
              zone,
              // #260: without this the card promised "your next devotional
              // is Thursday" to users with no calendar, directly above the
              // card telling them no calendar was connected.
              schedulingCapability(connectionCard.state),
            )}
          </p>
        }
      >
        {(events) => <UpcomingList events={events} zone={zone} />}
      </CardFrame>

      {/*
       * The calendar view (Epic M, #255). Placed under "Coming up"
       * because it is the same question at a different resolution — what
       * is next, then where that sits in the shape of the day — and
       * because #237's order puts presence before archive.
       *
       * Wellspring's own slots are handed down from the upcoming card rather
       * than fetched again: it is the same endpoint, already loaded, and
       * a second call would be a second thing to fail. `kairosKnowledge`
       * keeps the distinction between "nothing booked" and "we could not
       * find out" — an `error` card yields `unknown`, never `[]`.
       */}
      {/*
       * `workdayStartHour`/`workdayEndHour` are the user's own hours
       * (#265), parsed from the server's Postgres `time` strings by the
       * same helper `fromServer` uses — so the window the grid opens onto
       * is the window the scheduler books into, rather than a second
       * interpretation of the same two columns.
       */}
      <CalendarCard
        zone={zone}
        kairos={kairosKnowledge}
        workdayStartHour={hourFromLocalTime(preferences.windowStartLocal) ?? 9}
        workdayEndHour={hourFromLocalTime(preferences.windowEndLocal) ?? 17}
        onOpenSettings={onOpenSettings}
        onConnectCalendar={onConnectCalendar}
        now={now}
      />

      {/*
       * Rendered only when the server sent an address. Absent, never
       * broken (#239) — there is no placeholder branch below this line.
       */}
      {preferences.inviteAddress && <InviteAddressCard address={preferences.inviteAddress} />}

      {/*
       * The journal (N9, #268). Placed after the invite and before the
       * archive: it is a place to *bring* something, which belongs with
       * presence rather than with the record of the past. Owns its own
       * data and mutations (see the component) — a failure here degrades
       * only this card.
       */}
      <JournalCard zone={zone} />

      <CardFrame
        id="history"
        title="Your devotionals"
        state={historyCard.state}
        onRetry={historyCard.reload}
        emptyMessage={
          <p className="hint">
            Your devotionals will collect here as they happen, newest first.
          </p>
        }
      >
        {() => (
          <HistoryCardBody
            /*
             * `history`, not the card state's snapshot. The snapshot is
             * the first page as it was at load time and never changes;
             * "Show more" appends to `history`. Rendering the snapshot
             * would leave the button working, the request succeeding, and
             * the list visibly not growing — a control that does nothing,
             * which is the exact failure docs/05 P7 exists to prevent.
             */
            page={history}
            onOpen={(id) => onOpenDevotional(id)}
            onShowMore={() => void showMore()}
            loadingMore={loadingMore}
            searchAvailable={searchAvailable}
            onSearch={(q) => void runSearch(q)}
            searchResults={searchResults}
            searching={searching}
            onClearSearch={() => setSearchResults(null)}
          />
        )}
      </CardFrame>

      <CardFrame
        id="recap"
        title={recapTitle(recapMonth.year, recapMonth.month)}
        state={recapCard.state}
        onRetry={recapCard.reload}
        emptyMessage={
          <p className="hint">
            There isn’t a recap for last month yet. One appears once you’ve had devotionals in a
            month.
          </p>
        }
      >
        {(recap) => <RecapCardBody recap={recap} />}
      </CardFrame>

      {/*
       * The connection card in its original position — but only when it
       * was NOT promoted to the top (#266). `leadWithConnect` renders it
       * once, up top, for disconnected users; here it renders for
       * everyone else (connected, and the loading/error `unknown` states),
       * which keeps a connected user's dashboard exactly as it was.
       */}
      {!leadWithConnect && connectionCardFrame}

      <ComingSoonCards />
    </>
  );
}
