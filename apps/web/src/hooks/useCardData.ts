/**
 * One card, one fetch, one state (L1 #237, L9 #245).
 *
 * Every dashboard card calls this with its own loader. There is
 * deliberately no shared "dashboard is loading" flag anywhere in the app,
 * because the moment one exists, six independent fetches acquire a single
 * point of failure and the page goes blank when the least important of
 * them 500s. #237's "cards render independently" is only true if nothing
 * is in a position to render them together.
 *
 * The retry is a real re-run of the real loader, not a state reset — P7
 * again: the "Try again" button on an error card performs the action it
 * names.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CARD_ERROR_MESSAGE, loadingCard, type CardState } from '../lib/cardState';

export interface CardResult<T> {
  state: CardState<T>;
  reload: () => void;
}

export function useCardData<T>(
  load: () => Promise<CardState<T>>,
  deps: readonly unknown[] = [],
): CardResult<T> {
  const [state, setState] = useState<CardState<T>>(loadingCard<T>());

  /**
   * Guards against a resolved fetch writing into an unmounted component,
   * and against a slow first request overwriting a fast retry. Without the
   * generation counter a user who hits "Try again" during a hung request
   * can watch their successful retry be replaced by the original failure
   * when it finally settles.
   */
  const generation = useRef(0);

  const run = useCallback(() => {
    const current = generation.current + 1;
    generation.current = current;
    setState(loadingCard<T>());
    load()
      .then((next) => {
        if (generation.current === current) setState(next);
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return;
        setState({
          status: 'error',
          message: err instanceof Error && err.message ? err.message : CARD_ERROR_MESSAGE,
        });
      });
    // `load` is intentionally excluded from the dependency list: callers
    // define it inline, so a new identity arrives on every render and
    // including it would refetch in a loop. `deps` is the caller's
    // explicit statement of what should actually trigger a refetch.
    // (This repo does not install eslint-plugin-react-hooks, so there is
    // no exhaustive-deps warning to suppress — hence a comment rather
    // than a disable directive, which would itself be a lint error.)
  }, deps);

  useEffect(() => {
    run();
    // Unmount invalidates any in-flight write.
    return () => {
      generation.current += 1;
    };
  }, [run]);

  return { state, reload: run };
}
