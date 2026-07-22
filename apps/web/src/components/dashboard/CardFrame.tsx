/**
 * The frame every dashboard card renders inside (L9, issue #245).
 *
 * It owns the four-state taxonomy so each card writes only its `ready`
 * branch. That is what keeps the states *uniform* — #245 asks for one
 * taxonomy applied consistently, and a per-card hand-rolled error message
 * is how six cards end up with six different ideas of what failure looks
 * like.
 *
 * ## Accessibility decisions here rather than per card
 *
 * - Each card is a `<section>` with an accessible name from its own
 *   heading, so screen-reader users can navigate by region and by heading
 *   in the same order the cards appear visually (#237's a11y bar).
 * - The status line is a live region (`role="status"`), so a card that
 *   finishes loading or recovers on retry is **announced**, not merely
 *   repainted (#245 item 5). It is placed inside the section so the
 *   announcement carries the card's context.
 * - The loading state is a skeleton with text, never a bare spinner: a
 *   spinner conveys nothing to a screen reader and is indistinguishable
 *   from a hang to everyone else.
 */
import type { ReactNode } from 'react';
import type { CardState } from '../../lib/cardState';

export function CardFrame<T>({
  id,
  title,
  state,
  onRetry,
  emptyMessage,
  headerAction,
  children,
}: {
  /** Used for the heading id the section is labelled by — unique per card. */
  id: string;
  title: string;
  state: CardState<T>;
  onRetry: () => void;
  /**
   * The sentence shown when the card loaded and there is genuinely
   * nothing. Required, because "empty" without an explanation is the
   * failure mode #245 exists to prevent.
   */
  emptyMessage: ReactNode;
  /** The "+" slot on the today card (#237 item 4). */
  headerAction?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="card dash-card">
      <div className="dash-card-header">
        <h2 id={headingId}>{title}</h2>
        {headerAction}
      </div>

      {state.status === 'loading' && (
        <p className="hint" role="status">
          Loading…
        </p>
      )}

      {state.status === 'empty' && <div className="dash-empty">{emptyMessage}</div>}

      {state.status === 'error' && (
        <>
          {/*
            `role="alert"` rather than `status`: a card that failed is an
            interruption worth announcing immediately, and unlike the
            success case the user has something to do about it.
          */}
          <p className="notice notice-error" role="alert">
            {state.message}
          </p>
          <button type="button" className="secondary" onClick={onRetry}>
            Try again
            <span className="visually-hidden"> loading {title}</span>
          </button>
        </>
      )}

      {state.status === 'ready' && children(state.data)}
    </section>
  );
}
