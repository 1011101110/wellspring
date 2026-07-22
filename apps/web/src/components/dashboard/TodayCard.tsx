/**
 * "Where am I today?" (L7, issue #243) — the first card, by design.
 *
 * The layout order in #237 puts *presence* above *archive*: today, then
 * what is coming, and only then what has been. This card is the top of
 * that order and carries the "+" in its header (#237 item 4).
 *
 * Every sentence it can render is in `TODAY_HEADLINES`, and none of them
 * mentions a streak, a count, a percentage, or a missed session — see
 * `lib/todayCard.ts` for why that constraint is enforced by the module's
 * inputs rather than by this component's copy.
 */
import type { ReactNode } from 'react';
import type { LiturgicalSeason, Verse } from '@kairos/shared-contracts';
import { TODAY_HEADLINES, type TodayState } from '../../lib/todayCard';
import { formatTimeWithZone } from '../../lib/datetime';
import { seasonLine } from '../../lib/season';
import type { ScriptureAnchor } from '../../lib/scripture';

/**
 * The passage this card is showing, and where it came from (N2, #261).
 *
 * `null` — no devotional has ever been written for this user — renders
 * nothing at all. See `lib/scripture.ts` for why there is no stand-in.
 */
export interface TodayScripture {
  verse: Verse;
  provenance: ScriptureAnchor['provenance'];
}

/**
 * Scripture, with its attribution, in the treatment the session page
 * already uses (`.verse` + `<cite>`, `views/DevotionalDetail.tsx`).
 *
 * The attribution is not optional and is not a hover: Foundation §4.3
 * requires it to travel with the text everywhere the text appears, and the
 * byte-exact YouVersion rule is the reason this product can show Scripture
 * at all. It is rendered from `verse.attribution` — the string stored
 * alongside the passage when it was fetched — never assembled here.
 */
function VerseBlock({ scripture }: { scripture: TodayScripture }): ReactNode {
  return (
    <>
      {/*
       * `recent` says so, plainly, before the words. Unlabelled it would
       * read as "your verse for today" on a day nothing has been written
       * — a claim about a devotional that does not exist (#196).
       * `today` gets no caption because the passage is already sitting
       * under today's theme and needs no explaining.
       */}
      {scripture.provenance === 'recent' && (
        <p className="hint">From the last devotional Wellspring wrote for you.</p>
      )}
      <blockquote className="verse">
        <p>{scripture.verse.fetchedText}</p>
        <cite>
          {scripture.verse.reference} — {scripture.verse.attribution}
        </cite>
      </blockquote>
    </>
  );
}

export function TodayCardBody({
  state,
  zone,
  onOpenDevotional,
  season = null,
  scripture = null,
}: {
  state: TodayState;
  zone: string;
  onOpenDevotional: (id: string) => void;
  /** The church year, or `null` for "not this user's" — see `lib/season.ts`. */
  season?: LiturgicalSeason | null;
  /** Today's passage, or `null` when the user has no devotionals yet. */
  scripture?: TodayScripture | null;
}): ReactNode {
  const line = seasonLine(season);

  return (
    <>
      {/*
       * The season sits above the headline rather than below the fold:
       * it is the widest frame on the card ("where are we in the year")
       * and everything under it is narrower ("where are we today"). It is
       * set in the muted hint style on purpose — #269 asks for orienting
       * context, and a season that competes with the headline has become
       * the decoration it was not supposed to be.
       */}
      {line && <p className="hint">{line}</p>}

      <p className="lede">{TODAY_HEADLINES[state.kind]}</p>

      {(state.kind === 'ready' || state.kind === 'completed') && (
        <>
          <p className="readout">{state.devotional.theme}</p>
          <p className="hint">{state.devotional.cardSummary}</p>
          {/*
           * The passage, between the summary and the action. Above the
           * button rather than below it so the last thing read before
           * "Open today's devotional" is Scripture rather than a control
           * — which is the whole of #261 in one placement decision.
           */}
          {scripture && <VerseBlock scripture={scripture} />}
          <button
            type="button"
            className="primary"
            onClick={() => onOpenDevotional(state.devotional.id)}
          >
            {/*
             * "Open again" for a completed session rather than a disabled
             * button or a checkmark: re-reading a devotional you already
             * sat with is a normal thing to want, and there is nothing
             * here to congratulate or to close off.
             */}
            {state.kind === 'completed' ? 'Open it again' : 'Open today’s devotional'}
          </button>
        </>
      )}

      {state.kind === 'scheduled' && (
        <>
          <p className="readout">{formatTimeWithZone(state.event.gapStartAt, zone)}</p>
          {state.event.devotional ? (
            <p className="hint">{state.event.devotional.theme}</p>
          ) : (
            <p className="hint">
              Wellspring will have your devotional ready by then. It is on your calendar.
            </p>
          )}
          {state.event.meetUri && (
            /*
             * A real link to a real meeting. Opens in a new tab because
             * leaving the dashboard to join and then having no way back is
             * a worse outcome than an extra tab.
             */
            <a
              className="row-link"
              href={state.event.meetUri}
              target="_blank"
              rel="noreferrer noopener"
            >
              Join the meeting
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
        </>
      )}

      {state.kind === 'open' && (
        <p className="hint">
          Wellspring books devotionals into the open moments on your calendar. You can also make one
          right now with the button above.
        </p>
      )}

      {/*
       * `scheduled` and `open` are the states with nothing written for
       * today, and `open` is the emptiest surface in the product — #261
       * names it as where a verse does the most work. The passage is the
       * last thing on the card in both, so an otherwise-empty Today card
       * ends on Scripture instead of on an explanation of how scheduling
       * works.
       */}
      {(state.kind === 'scheduled' || state.kind === 'open') && scripture && (
        <VerseBlock scripture={scripture} />
      )}
    </>
  );
}
