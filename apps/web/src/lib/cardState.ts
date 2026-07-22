/**
 * The per-card async state taxonomy (L9, issue #245).
 *
 * ## Why a shared type rather than three `useState`s per card
 *
 * #237 and #245 both turn on one structural property: **cards fail
 * independently**. One failed fetch degrades one card and never blanks the
 * page, and there is no spinner-of-everything. The reliable way to get
 * that is for each card to own a complete state value — so there is no
 * page-level `loading` boolean for anything to gate on, because such a
 * boolean is how six independent fetches silently become one.
 *
 * A card is in exactly one of four states, and the union makes the
 * combinations that caused #225-class bugs unrepresentable: there is no
 * value here that is simultaneously "loading" and "has stale data the user
 * is looking at", and no way to render an empty list because a fetch
 * failed. `error` carries a message and nothing else; a card in `error`
 * cannot accidentally render as empty, which is the specific confusion
 * #245 calls out ("failed pull ≠ not onboarded", applied per card).
 *
 * `empty` is a first-class state rather than `ready` with a zero-length
 * array, because an empty upcoming list is a *real answer* that needs its
 * own sentence ("Your next devotional is Monday") and not a shrug. Making
 * it a distinct state means a card physically cannot render emptiness as
 * failure — the branch that would do so does not exist.
 */
export type CardState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export const loadingCard = <T,>(): CardState<T> => ({ status: 'loading' });
export const readyCard = <T,>(data: T): CardState<T> => ({ status: 'ready', data });
export const emptyCard = <T,>(): CardState<T> => ({ status: 'empty' });
export const errorCard = <T,>(message: string): CardState<T> => ({ status: 'error', message });

/**
 * Turns a settled fetch into a card state, folding "succeeded but there is
 * nothing" into `empty` via a caller-supplied predicate.
 *
 * The predicate is required rather than defaulted to `length === 0`
 * because "nothing" means something different per card: an empty
 * devotional list is empty, but a `null` today-devotional is a state with
 * real copy of its own.
 */
export function toCardState<T>(data: T, isEmpty: (value: T) => boolean): CardState<T> {
  return isEmpty(data) ? emptyCard<T>() : readyCard(data);
}

/**
 * Copy for a card that could not load.
 *
 * Per-card and deliberately mild: one card failing is not an outage, and
 * the user still has five other cards that worked. The retry is a real
 * control that re-runs the real fetch (docs/05 P7) — this is not a
 * decorative "something went wrong".
 */
export const CARD_ERROR_MESSAGE = 'This did not load. You can try again.';
