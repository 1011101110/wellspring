/**
 * Scripture on the dashboard (N2, issue #261).
 *
 * ## The finding
 *
 * Every string on the shipped dashboard was scheduling metadata — themes,
 * times, summaries, connection status, month names. Not one word of
 * Scripture. "The church noticeboard, not the sanctuary." This module
 * decides *which* verse the Today card shows and, just as importantly,
 * *what the card is allowed to say about why it is showing it*.
 *
 * ## Where the text comes from: the user's own devotionals, and nowhere else
 *
 * Every verse Wellspring has ever shown this user was fetched byte-exact from
 * YouVersion at generation time and stored on the devotional row
 * (`verses[]`, with `usfm`, `reference`, `fetchedText`, `attribution`).
 * That is the only Scripture in the system, and it is what this card
 * renders. Nothing here composes, paraphrases, or selects a passage —
 * docs/14 §5.10's "no model-generated Scripture paraphrases" is a
 * theological position, and a client that picked its own verse of the day
 * would be making exactly the editorial claim that rule refuses.
 *
 * ## Provenance is part of the render (#196)
 *
 * #261 warns against framing the verse as chosen *for* the user's state
 * unless it actually was. Two cases, and they are genuinely different:
 *
 *  - `today` — the devotional for today exists, and this is its passage.
 *    It *was* chosen against today's signals. It needs no caption; it is
 *    simply today's Scripture, sitting under today's theme.
 *  - `recent` — nothing has been written for today yet. The verse is the
 *    one from the last devotional the user was given, and the card must
 *    say so. Unlabelled, it would read as "here is your verse for today",
 *    which is a claim about a devotional that does not exist.
 *
 * There is no third case that invents one. See `anchorForToday`.
 *
 * ## Why this is a separate fetch and not a wider list payload
 *
 * #261 proposes widening `DevotionalCard` to carry `verses`. That shape
 * was narrowed on purpose in #241: the archive list is the one payload in
 * the product that grows without bound as the user succeeds at using it,
 * and it is projected down to card fields precisely so a year of daily use
 * does not ship a year of devotional content to draw a list of themes.
 * Adding verses would put ~20 verse arrays on every page of an archive
 * that renders none of them, to serve one card that needs exactly one.
 *
 * So the card reads the verse from `GET /v1/devotionals/:id` — the
 * endpoint that already returns `verses` under the real `VerseSchema`,
 * already used by the detail view, and unchanged by this work. The
 * tradeoff is one extra request per dashboard load, which buys: no
 * contract change, no growth in the unbounded payload, and a verse fetch
 * that fails on its own without taking the Today card with it (#237's
 * card-independence rule, applied one level down).
 */
import type { DevotionalCard, Verse } from '@kairos/shared-contracts';
import type { TodayState } from './todayCard';

/**
 * Which devotional the card should read a verse from, and what the card
 * may claim about it. `null` means there is no Scripture to show — see
 * `anchorForToday`.
 */
export interface ScriptureAnchor {
  devotionalId: string;
  /** `today`: this is today's passage. `recent`: it is the last one the user was given. */
  provenance: 'today' | 'recent';
}

/**
 * Picks the devotional whose Scripture the Today card should render.
 *
 * `devotionals` is the first page of the archive, newest first — the same
 * data `deriveTodayState` was built from, so no additional request is
 * needed to make this decision.
 *
 * ## `null` for a genuinely new user, on purpose
 *
 * A user with no devotionals at all gets no verse, and the card says
 * nothing about it. There is no honest alternative: the repo does contain
 * real Scripture in `fixtures/snapshots/*.json` (the band-keyed fallback
 * devotionals), and rendering one of those would satisfy the letter of
 * #261's "ideally `open` too" while producing precisely what the issue
 * warns against two lines later — *"a verse that's always the same, or
 * clearly ornamental, is worse than none."* A fixture verse would be the
 * same passage for every new user on every visit, and it would be
 * presented on a card about *their* devotionals while belonging to none of
 * them. Absence is the truthful state and it is what renders.
 *
 * The acceptance criterion this does satisfy in full: *"a returning user's
 * dashboard contains Scripture without opening anything"* — a returning
 * user has history, so every state below `ready`/`completed` still finds a
 * passage.
 */
export function anchorForToday(
  state: TodayState,
  devotionals: readonly DevotionalCard[],
): ScriptureAnchor | null {
  if (state.kind === 'ready' || state.kind === 'completed') {
    return { devotionalId: state.devotional.id, provenance: 'today' };
  }

  /*
   * `scheduled` and `open` both mean "nothing written for today yet", so
   * both fall back to the newest devotional there is. It cannot be
   * today's: `deriveTodayState` returns `ready`/`completed` whenever a
   * devotional carries today's date, so reaching here means the newest row
   * is from an earlier day — which is exactly what `recent` claims.
   */
  const mostRecent = devotionals[0];
  return mostRecent ? { devotionalId: mostRecent.id, provenance: 'recent' } : null;
}

/**
 * The passage to show from a devotional's verses.
 *
 * The first, not a random one and not all of them. A devotional's verse
 * array is ordered by the generator with its primary passage first, and
 * rotating through them on a card the user reloads would manufacture
 * variety that means nothing — the card would appear to be saying
 * something new when only an index moved.
 *
 * `null` for an empty array. `DevotionalOutputSchema` requires at least
 * one verse so this should be unreachable for any generated devotional,
 * but the read path returns a stored database row rather than re-validated
 * output, and rendering `undefined.fetchedText` is a worse failure than
 * rendering no verse.
 */
export function primaryVerse(verses: readonly Verse[]): Verse | null {
  return verses[0] ?? null;
}
