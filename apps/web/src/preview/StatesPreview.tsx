/**
 * The dashboard's states, all on one page (L9, issue #245).
 *
 * #245's acceptance asks that "each card demonstrates all four states
 * (storybook-style test page or preview fixtures)". This is that page.
 *
 * ## It is a development artifact, not a route
 *
 * It is served from `preview.html`, which Vite builds only when asked for
 * it explicitly — `vite build` emits `index.html` and this page is not in
 * its graph, so nothing here ships to users. It imports the real card
 * components with fixture props and makes no network calls at all, which
 * is what lets it show an error state and an empty state side by side
 * without a server that can produce them on demand.
 *
 * Its value is the composition question a unit test cannot answer: does a
 * dashboard where every card is empty read as orientation, or as six
 * apologies? That is a judgement made by looking.
 */
import { useState } from 'react';
import { CalendarControls } from '../components/dashboard/calendar/CalendarControls';
import { CardFrame } from '../components/dashboard/CardFrame';
import { ComingSoonCards } from '../components/dashboard/ComingSoonCards';
import { ConnectionCardBody } from '../components/dashboard/ConnectionCardBody';
import { HistoryCardBody } from '../components/dashboard/HistoryCard';
import { InviteAddressCard } from '../components/dashboard/InviteAddressCard';
import { RecapCardBody, recapTitle } from '../components/dashboard/RecapCardBody';
import { TodayCardBody, type TodayScripture } from '../components/dashboard/TodayCard';
import { UpcomingList } from '../components/dashboard/UpcomingList';
import { MonthGrid } from '../components/dashboard/calendar/MonthGrid';
import { TimeGrid } from '../components/dashboard/calendar/TimeGrid';
import {
  gridRange,
  monthCells,
  periodLabel,
  PRIVACY_NOTE,
  unknownBusyMessage,
  workdayWindow,
  type BusyKnowledge,
  type CalendarViewMode,
} from '../lib/calendarGrid';
import { zonedTimeToInstant } from '../lib/datetime';
import { emptyUpcomingMessage } from '../lib/upcoming';
import { RETURN_GAP_DAYS, returnGreeting } from '../lib/returnGreeting';
import { readyCard, emptyCard, errorCard, loadingCard } from '../lib/cardState';
import type { TodayState } from '../lib/todayCard';
import type { UpcomingCalendarEvent } from '@kairos/shared-contracts';
import type { HistoryPage } from '../lib/history';
import type { ConnectionState } from '../lib/connectionState';
import type { LiturgicalSeason, MonthlyRecapResponseData } from '@kairos/shared-contracts';
import {
  connectionActive,
  devotionalCompleted,
  devotionalToday,
  devotionalsPast,
  PREVIEW_NOW,
  PREVIEW_ZONE,
  previewVerse,
  recap,
  upcomingEvents,
} from './fixtures';

const WEEKDAYS = [1, 2, 3, 4, 5];
const noop = () => {};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="preview-section">
      <h2 className="preview-heading">{title}</h2>
      {children}
    </section>
  );
}

/** Every card in its loading, empty, and error states — the three that are uniform. */
function UniformStates() {
  return (
    <>
      <CardFrame
        id="p-loading"
        title="Loading"
        state={loadingCard<never>()}
        onRetry={noop}
        emptyMessage={null}
      >
        {() => null}
      </CardFrame>

      <CardFrame
        id="p-error"
        title="Error, with a retry that really refetches"
        state={errorCard<never>('This did not load. You can try again.')}
        onRetry={noop}
        emptyMessage={null}
      >
        {() => null}
      </CardFrame>
    </>
  );
}

/**
 * The season the preview renders (N10, #269). A fixed value, because the
 * preview is deterministic — `PREVIEW_NOW` pins the date for every other
 * card and the church year is no different. `lent` rather than
 * `ordinary_time` so the line actually has something to say.
 */
const PREVIEW_SEASON: LiturgicalSeason = 'lent';

/**
 * The Today card's Scripture per state (N2, #261) — and the provenance
 * caption that goes with it, which is the part worth being able to see
 * side by side.
 *
 * `ready`/`completed` show the passage as today's, uncaptioned.
 * `scheduled`/`open` show the same passage captioned as the last
 * devotional's, because nothing has been written for today. Getting that
 * label wrong is the failure #196 names, and this is the surface where a
 * reviewer would catch it.
 */
function previewScripture(kind: TodayState['kind']): TodayScripture {
  return {
    verse: previewVerse,
    provenance: kind === 'ready' || kind === 'completed' ? 'today' : 'recent',
  };
}

export function StatesPreview() {
  // Real state, so the radio group's arrow-key behaviour is exercisable
  // rather than merely depicted.
  const [previewMode, setPreviewMode] = useState<CalendarViewMode>('day');
  const todayStates: TodayState[] = [
    { kind: 'open' },
    { kind: 'ready', devotional: devotionalToday },
    { kind: 'completed', devotional: devotionalCompleted },
    { kind: 'scheduled', event: upcomingEvents[0]! },
  ];

  const connectionStates: ConnectionState[] = [
    { kind: 'never' },
    { kind: 'active', connection: connectionActive },
    { kind: 'revoked', connection: { ...connectionActive, status: 'revoked' } },
    { kind: 'unknown', connection: { ...connectionActive, status: 'error' } },
  ];

  const historyPage: HistoryPage = { items: devotionalsPast, nextCursor: 'cursor-1' };

  // --- Epic M fixtures ------------------------------------------------
  const at = (day: string, hour: number, minute = 0) =>
    zonedTimeToInstant(day, hour, minute, PREVIEW_ZONE).toISOString();

  const dayRange = gridRange('day', '2026-07-22', PREVIEW_ZONE);
  const weekRange = gridRange('week', '2026-07-22', PREVIEW_ZONE);
  const monthRange = gridRange('month', '2026-07-22', PREVIEW_ZONE);
  const dstRange = gridRange('week', '2026-03-08', PREVIEW_ZONE);

  const busyKnown: BusyKnowledge = {
    kind: 'known',
    blocks: [
      { start: at('2026-07-22', 9), end: at('2026-07-22', 10, 30) },
      { start: at('2026-07-22', 13), end: at('2026-07-22', 14) },
      { start: at('2026-07-22', 16), end: at('2026-07-22', 17) },
      { start: at('2026-07-20', 8), end: at('2026-07-20', 12) },
      { start: at('2026-07-21', 11), end: at('2026-07-21', 11, 20) },
      // Spans midnight — must appear on both the 23rd and the 24th.
      { start: at('2026-07-23', 22), end: at('2026-07-24', 6) },
      { start: at('2026-07-06', 9), end: at('2026-07-06', 17) },
      { start: at('2026-07-14', 10), end: at('2026-07-14', 11) },
    ],
  };

  const busyDst: BusyKnowledge = {
    kind: 'known',
    // 2 PM on the short day is 13 hours after midnight, not 14.
    blocks: [{ start: at('2026-03-08', 14), end: at('2026-03-08', 15) }],
  };

  const busyUnknown: BusyKnowledge = { kind: 'unknown', reason: 'consent_disabled' };

  return (
    <main id="main">
      <h1>Dashboard states (#245)</h1>
      <p className="hint">
        Fixture-driven. No network calls — every state below is rendered directly.
      </p>

      <Section title="First run — a brand-new, disconnected account, as one screen (#266/#267)">
        {/*
         * The composition #245 asked to be reviewed as its own screen —
         * but #267 found this section was showing five of the real nine
         * first-run blocks, and #266 found the ones it did show were in
         * the wrong order. Both survived review *because* the preview was
         * unfaithful: a reviewer cannot judge an ordering they cannot see.
         *
         * So this now mirrors the real disconnected first-run dashboard,
         * block for block and in order:
         *   connect (led with) → welcome → today → upcoming → calendar
         *   (collapsed) → invite → history → recap → coming-soon
         *
         * `firstRunComposition.test.ts` fails the build if the real
         * dashboard grows a card this section does not, so it cannot drift
         * back to "five of nine".
         */}

        {/*
         * Led with (#266): for a disconnected user the connect action is
         * the one thing that turns everything else on, so it is first.
         * `never`, because a brand-new account has no connection row.
         */}
        <CardFrame
          id="p-fr-connection"
          title="Calendar"
          state={readyCard<ConnectionState>({ kind: 'never' })}
          onRetry={noop}
          emptyMessage={null}
        >
          {(s) => <ConnectionCardBody state={s} zone={PREVIEW_ZONE} onConnect={noop} />}
        </CardFrame>

        <section className="card dash-card">
          <h2>Welcome to Wellspring</h2>
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

        <CardFrame
          id="p-fr-today"
          title="Today"
          state={readyCard<TodayState>({ kind: 'open' })}
          onRetry={noop}
          emptyMessage={null}
        >
          {(s) => (
            /*
             * No `scripture` here on purpose: this is the FIRST RUN
             * section, and a user with no devotionals has no Scripture in
             * the system. `lib/scripture.ts` explains why nothing stands
             * in for it — the preview must show that absence rather than
             * hide it behind a fixture (#267's whole complaint about this
             * file).
             */
            <TodayCardBody
              state={s}
              zone={PREVIEW_ZONE}
              onOpenDevotional={noop}
              season={PREVIEW_SEASON}
            />
          )}
        </CardFrame>

        <CardFrame
          id="p-fr-upcoming"
          title="Coming up"
          state={emptyCard<readonly UpcomingCalendarEvent[]>()}
          onRetry={noop}
          emptyMessage={
            <p className="hint">
              {/*
               * `disconnected` because this is the FIRST RUN section: a
               * user who has just onboarded has no calendar yet. Passing
               * `connected` here would reproduce the #260 bug inside the
               * very preview built to catch it — the preview claiming a
               * Thursday devotional two cards above "No calendar
               * connected" is exactly what shipped.
               */}
              {emptyUpcomingMessage(WEEKDAYS, PREVIEW_NOW, PREVIEW_ZONE, 'disconnected')}
            </p>
          }
        >
          {() => null}
        </CardFrame>

        {/*
         * The calendar collapsed to a single statement + action (#266).
         * A disconnected user's free/busy is fully unknown and Wellspring has
         * booked nothing, so the real CalendarCard renders exactly this
         * degraded notice in place of a 42-cell grid saying "we don't
         * know" fifty times. Rendered as the notice directly, because the
         * live CalendarCard fetches and this page makes no network calls.
         */}
        <CardFrame
          id="p-fr-calendar"
          title="Your calendar"
          state={readyCard<null>(null)}
          onRetry={noop}
          emptyMessage={null}
        >
          {() => (
            <div className="notice notice-warn cal-degraded" role="status">
              <p>{unknownBusyMessage('not_connected')}</p>
              <button type="button" className="secondary" onClick={noop}>
                Connect Google Calendar
              </button>
            </div>
          )}
        </CardFrame>

        {/*
         * The invite address card. Absent entirely when the server sent no
         * address (#239), but a first-run user often has one, and its
         * place in the composition is here — so the preview shows it.
         */}
        <InviteAddressCard address="u_9f3c2a10-0b4e-4c77-9a1d-2f6b8e5c1d90@lexirdro.resend.app" />

        <CardFrame
          id="p-fr-history"
          title="Your devotionals"
          state={emptyCard<HistoryPage>()}
          onRetry={noop}
          emptyMessage={
            <p className="hint">Your devotionals will collect here as they happen, newest first.</p>
          }
        >
          {() => null}
        </CardFrame>

        <CardFrame
          id="p-fr-recap"
          title={recapTitle(2026, 6)}
          state={emptyCard<MonthlyRecapResponseData>()}
          onRetry={noop}
          emptyMessage={
            <p className="hint">
              There isn’t a recap for last month yet. One appears once you’ve had devotionals in a
              month.
            </p>
          }
        >
          {() => null}
        </CardFrame>

        <ComingSoonCards />
      </Section>

      {/*
       * The return greeting (#282). Rendered through the REAL
       * `returnGreeting` with a date well past the gap, so the copy shown
       * here is the copy shipped — and if it ever gains a number, the
       * `never contains a number` test fails before this preview would
       * mislead anyone. Grace notices; it does not charge.
       */}
      <Section title="Returning after a gap — grace notices, never counts (#282)">
        <p className="notice" role="status">
          {returnGreeting('2026-06-01', PREVIEW_NOW, PREVIEW_ZONE)}
        </p>
        <p className="hint">
          Shown above the dashboard only after {String(RETURN_GAP_DAYS)}+ days away, and only to a
          user who has a devotional history (a first-run user gets the welcome instead). No count, no
          date, no “you missed” — that boundary is Foundation §9.
        </p>
      </Section>

      {/*
       * The journal (#268). Rendered as static markup rather than the live
       * `<JournalCard>`, for the same reason the collapsed calendar above
       * is: the real card fetches on mount and this page makes no network
       * calls. The heading and structure mirror the component so a reviewer
       * sees the same shape; `firstRunComposition.test.ts` asserts the
       * dashboard's `<JournalCard>` and this preview presence cannot drift
       * apart.
       */}
      <Section title="Journal — a place to bring something, kept (#268)">
        <section aria-label="Your journal (preview)" className="card dash-card">
          <div className="dash-card-header">
            <h2>Your journal</h2>
          </div>
          <p className="hint">
            A place for whatever you’re carrying. Kept until you delete it, and never used to write
            your devotionals — it’s just for you.
          </p>
          <textarea
            className="journal-draft"
            defaultValue=""
            placeholder="Is there something on your mind?"
            rows={3}
          />
          <button type="button" className="primary">
            Keep this
          </button>
          <ul className="journal-entries">
            <li className="journal-entry">
              <p className="journal-entry-date hint">Sunday</p>
              <p className="journal-entry-text">
                Carrying my mother’s health this week. Asked for patience.
              </p>
              <button type="button" className="quiet journal-delete" aria-label="Delete this journal entry">
                Delete
              </button>
            </li>
          </ul>
        </section>
        <section aria-label="Empty journal (preview)" className="card dash-card">
          <div className="dash-card-header">
            <h2>Your journal</h2>
          </div>
          <p className="hint">Nothing here yet. Whatever you write will stay, in your words.</p>
        </section>
      </Section>

      <Section title="Loading and error — uniform across every card">
        <UniformStates />
      </Section>

      <Section title="Today card — all four states">
        {todayStates.map((state) => (
          <CardFrame
            key={state.kind}
            id={`p-today-${state.kind}`}
            title={`Today — ${state.kind}`}
            state={readyCard(state)}
            onRetry={noop}
            emptyMessage={null}
          >
            {(s) => (
              <TodayCardBody
                state={s}
                zone={PREVIEW_ZONE}
                onOpenDevotional={noop}
                season={PREVIEW_SEASON}
                scripture={previewScripture(s.kind)}
              />
            )}
          </CardFrame>
        ))}
      </Section>

      <Section title="Coming up — populated, and empty on a weekend">
        <CardFrame
          id="p-up-ready"
          title="Coming up"
          state={readyCard<readonly UpcomingCalendarEvent[]>(upcomingEvents)}
          onRetry={noop}
          emptyMessage={null}
        >
          {(events) => <UpcomingList events={events} zone={PREVIEW_ZONE} />}
        </CardFrame>

        <CardFrame
          id="p-up-empty"
          title="Coming up — Saturday, default schedule"
          state={emptyCard<readonly UpcomingCalendarEvent[]>()}
          onRetry={noop}
          emptyMessage={
            <p className="hint">
              {/* Connected: this section is about the weekend gap in a
                  working schedule, which only arises once Wellspring can book. */}
              {emptyUpcomingMessage(
                WEEKDAYS,
                new Date('2026-07-18T18:00:00Z'),
                PREVIEW_ZONE,
                'connected',
              )}
            </p>
          }
        >
          {() => null}
        </CardFrame>
      </Section>

      <Section title="Invite address (absent entirely when unconfigured)">
        <InviteAddressCard address="u_9f3c2a10-0b4e-4c77-9a1d-2f6b8e5c1d90@lexirdro.resend.app" />
      </Section>

      <Section title="Your devotionals — with search available">
        <CardFrame
          id="p-hist"
          title="Your devotionals"
          state={readyCard(historyPage)}
          onRetry={noop}
          emptyMessage={null}
        >
          {(page) => (
            <HistoryCardBody
              page={page}
              onOpen={noop}
              onShowMore={noop}
              loadingMore={false}
              searchAvailable
              onSearch={noop}
              searchResults={null}
              searching={false}
              onClearSearch={noop}
            />
          )}
        </CardFrame>
      </Section>

      <Section title="Recap — narrative only, no counts">
        <CardFrame
          id="p-recap"
          title={recapTitle(2026, 6)}
          state={readyCard<MonthlyRecapResponseData>(recap)}
          onRetry={noop}
          emptyMessage={null}
        >
          {(r) => <RecapCardBody recap={r} />}
        </CardFrame>
      </Section>

      <Section title="Calendar — all four connection states">
        {connectionStates.map((state) => (
          <CardFrame
            key={state.kind}
            id={`p-conn-${state.kind}`}
            title={`Calendar — ${state.kind}`}
            state={readyCard(state)}
            onRetry={noop}
            emptyMessage={null}
          >
            {(s) => <ConnectionCardBody state={s} zone={PREVIEW_ZONE} onConnect={noop} />}
          </CardFrame>
        ))}
      </Section>

      {/*
       * Epic M's three views (#255). Rendered from fixtures because the
       * layout questions they raise are ones a unit test cannot answer:
       * whether the hour axis lines up with the blocks, whether a 23-hour
       * column reads as a rendering bug, and — the one that matters most
       * — whether a degraded calendar is visibly distinguishable from an
       * open one at a glance rather than only in the DOM.
       */}
      {/*
       * The controls were absent from this preview until #264, which is
       * why their two accessibility defects survived review: a focus ring
       * you cannot see and a 31.4px target are both invisible in source
       * and obvious the moment the thing is on screen and measurable.
       * They are stateful here — the toggle really switches — because a
       * frozen screenshot of a radio group cannot show whether arrow keys
       * move the selection. (The wider preview/reality gap is #267.)
       */}
      <Section title="Calendar — controls (focus ring and target size are measurable here)">
        <div className="card dash-card">
          <CalendarControls
            mode={previewMode}
            onModeChange={setPreviewMode}
            periodLabel="Sunday, July 19"
            onShift={noop}
            onToday={noop}
            atToday={false}
          />
        </div>
      </Section>

      {/*
       * Windowed to a 9–5 day (#265) — the composition a real user sees.
       * The unwindowed variant is below it, because the two questions
       * ("does the workday read clearly?" and "can I still find a 6am
       * meeting?") are different and both need looking at.
       */}
      <Section title="Calendar — day view, windowed to the user's hours (#265)">
        <div className="card dash-card">
          <p className="hint cal-privacy">{PRIVACY_NOTE}</p>
          <TimeGrid
            range={dayRange}
            busy={busyKnown}
            events={upcomingEvents}
            window={workdayWindow(9, 17)}
          />
        </div>
      </Section>

      <Section title="Calendar — day view, whole day (the escape hatch)">
        <div className="card dash-card">
          <p className="hint cal-privacy">{PRIVACY_NOTE}</p>
          <TimeGrid range={dayRange} busy={busyKnown} events={upcomingEvents} />
        </div>
      </Section>

      <Section title="Calendar — week view">
        <div className="card dash-card">
          <p className="hint cal-privacy">{PRIVACY_NOTE}</p>
          <TimeGrid range={weekRange} busy={busyKnown} events={upcomingEvents} />
        </div>
      </Section>

      <Section title="Calendar — the spring-forward week (2026-03-08 is 23 hours)">
        <div className="card dash-card">
          <TimeGrid range={dstRange} busy={busyDst} events={[]} />
        </div>
      </Section>

      <Section title="Calendar — consent revoked (must not read as a free day)">
        <div className="card dash-card">
          <p className="notice notice-warn">{unknownBusyMessage('consent_disabled')}</p>
          <TimeGrid range={weekRange} busy={busyUnknown} events={upcomingEvents} />
        </div>
      </Section>

      <Section title="Calendar — month view (no heatmap, by design)">
        <div className="card dash-card">
          <p className="hint cal-privacy">{PRIVACY_NOTE}</p>
          <MonthGrid
            cells={monthCells(monthRange, '2026-07-22', busyKnown, upcomingEvents)}
            monthLabel={periodLabel('month', monthRange, '2026-07-22')}
            zone={PREVIEW_ZONE}
            todayKey="2026-07-22"
          />
        </div>
      </Section>

      <Section title="Calendar — month view, calendar not connected">
        <div className="card dash-card">
          <MonthGrid
            cells={monthCells(monthRange, '2026-07-22', busyUnknown, upcomingEvents)}
            monthLabel={periodLabel('month', monthRange, '2026-07-22')}
            zone={PREVIEW_ZONE}
            todayKey="2026-07-22"
          />
        </div>
      </Section>

      <Section title="Coming soon — content only, no controls">
        <ComingSoonCards />
      </Section>
    </main>
  );
}
