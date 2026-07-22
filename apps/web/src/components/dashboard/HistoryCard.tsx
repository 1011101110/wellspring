/**
 * The archive: past devotionals, paging, and search (L5 #241, L6 #242).
 *
 * ## Search is gated on the endpoint existing
 *
 * `GET /v1/devotionals/search` is in review and not merged. The search box
 * is rendered only after a probe query comes back as something other than
 * a 404 — so on a deployment without the endpoint there is no search
 * control at all, rather than a box that errors on every submit. That is
 * docs/05 P7 applied to a feature gate: a control that does nothing does
 * not ship, and "does nothing because the backend isn't there yet" is
 * still nothing.
 *
 * Results render through the same row component as the archive because the
 * endpoint returns the same `DevotionalCard` shape — which is also what
 * makes the UI safe to build ahead of the merge.
 *
 * ## Paging, not infinite scroll
 *
 * An explicit "Show more" button. Infinite scroll on an archive of quiet
 * daily devotionals would be an engagement pattern in a product whose
 * whole posture is the opposite (Foundation §9), and it is also
 * keyboard-hostile: there is no way to reach whatever follows the list.
 */
import { useState } from 'react';
import type { DevotionalCard } from '@kairos/shared-contracts';
import { formatCalendarDate } from '../../lib/datetime';
import { hasMore, type HistoryPage } from '../../lib/history';

function DevotionalRow({
  card,
  onOpen,
}: {
  card: DevotionalCard;
  onOpen: (id: string) => void;
}) {
  return (
    <li className="dash-row">
      <p className="readout">{card.theme}</p>
      {/* `card.date` is a calendar day, not an instant — see
          `formatCalendarDate`. Zone-converting it renders the day before. */}
      <p className="dash-row-time">{formatCalendarDate(card.date)}</p>
      <p className="hint">{card.cardSummary}</p>
      {/*
       * Completion is stated only when it happened, and never counted.
       * There is deliberately no "not completed" badge: an unopened
       * devotional is not a failure and marking it would be the greyed
       * calendar of guilt #243 rules out.
       */}
      {card.completedAt && <p className="hint">You sat with this one.</p>}
      <button type="button" className="secondary" onClick={() => onOpen(card.id)}>
        Open
        <span className="visually-hidden">: {card.theme}</span>
      </button>
    </li>
  );
}

export function HistoryCardBody({
  page,
  onOpen,
  onShowMore,
  loadingMore,
  searchAvailable,
  onSearch,
  searchResults,
  searching,
  onClearSearch,
}: {
  page: HistoryPage;
  onOpen: (id: string) => void;
  onShowMore: () => void;
  loadingMore: boolean;
  /** False when the endpoint 404s — the control is then absent entirely. */
  searchAvailable: boolean;
  onSearch: (query: string) => void;
  searchResults: readonly DevotionalCard[] | null;
  searching: boolean;
  onClearSearch: () => void;
}) {
  const [query, setQuery] = useState('');

  const showing = searchResults ?? page.items;

  return (
    <>
      {searchAvailable && (
        <form
          className="dash-search"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = query.trim();
            if (trimmed) onSearch(trimmed);
          }}
        >
          {/* A real label, not a placeholder: placeholder-as-label vanishes
              on focus and is not reliably announced. */}
          <label htmlFor="devotional-search">Search your devotionals</label>
          <div className="row">
            <input
              id="devotional-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="secondary" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
        </form>
      )}

      {/* Announced: #245 asks for results-loaded to be spoken, not just
          painted. */}
      <p className="visually-hidden" role="status">
        {searching
          ? 'Searching your devotionals.'
          : searchResults
            ? searchResults.length === 0
              ? 'No devotionals matched your search.'
              : 'Search results loaded.'
            : ''}
      </p>

      {searchResults && (
        <div className="dash-search-summary">
          <p className="hint">
            {searchResults.length === 0
              ? 'Nothing matched that search.'
              : 'Showing what matched your search.'}
          </p>
          <button type="button" className="quiet" onClick={onClearSearch}>
            Show all devotionals
          </button>
        </div>
      )}

      <ul className="dash-list">
        {showing.map((card) => (
          <DevotionalRow key={card.id} card={card} onOpen={onOpen} />
        ))}
      </ul>

      {/* "Show more" belongs to the archive, not to a result set — search
          returns its own complete answer. */}
      {!searchResults && hasMore(page) && (
        <button type="button" className="secondary" onClick={onShowMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </>
  );
}
