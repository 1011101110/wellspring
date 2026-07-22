/**
 * The journal (N9, #268) — a place to write what you are carrying, kept
 * until you delete it.
 *
 * ## What this card is, and is not
 *
 * It is a private journal. It is NOT a mood tracker, a streak, or a
 * counter: it shows the words the person wrote and offers to keep or
 * remove them, and nothing here reduces those words to a number
 * (Foundation §9, ruling #271 — Wellspring keeps your words, it never charges
 * you for them). The one sentence of orientation says plainly what happens
 * to the text — kept, and never used to write your devotionals — because
 * "the retention and generation-use of anything typed is stated in the UI"
 * is one of #268's acceptance criteria, not a footnote.
 *
 * ## Why it owns its own fetch and mutations
 *
 * Unlike the read-only cards, the journal writes. It manages its own list
 * with optimistic-but-honest updates: a new entry is prepended only after
 * the server confirms it (so the id is real and a later delete cannot miss),
 * and a delete removes the row only after the server confirms it. A failed
 * write leaves the textarea's words intact — losing what someone just wrote
 * because a request failed is the one thing a journal must never do.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JournalEntry } from '@kairos/shared-contracts';
import { createJournalEntry, deleteJournalEntry, getJournal } from '../../api/journal';
import { formatDay } from '../../lib/datetime';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; entries: JournalEntry[]; nextCursor: string | null }
  | { status: 'error' };

export function JournalCard({ zone }: { zone: string }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const page = await getJournal(null);
      if (live.current) {
        setLoad({ status: 'ready', entries: [...page.data], nextCursor: page.nextCursor });
      }
    } catch {
      if (live.current) setLoad({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save() {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const entry = await createJournalEntry(text);
      // Only clear the textarea once the server has the words. Prepend the
      // real entry (with its real id) rather than a placeholder.
      setDraft('');
      setLoad((prev) =>
        prev.status === 'ready'
          ? { ...prev, entries: [entry, ...prev.entries] }
          : { status: 'ready', entries: [entry], nextCursor: null },
      );
    } catch {
      // The draft is deliberately NOT cleared — the words stay in the box.
      setSaveError('That didn’t save. Your words are still here — try again.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(id: string) {
    try {
      await deleteJournalEntry(id);
      setLoad((prev) =>
        prev.status === 'ready'
          ? { ...prev, entries: prev.entries.filter((e) => e.id !== id) }
          : prev,
      );
    } catch {
      // Leave the entry in place — a failed delete that hid the row anyway
      // would be the #213 class of lie (a control claiming success it did
      // not have).
    } finally {
      setPendingDelete(null);
    }
  }

  async function showMore() {
    if (load.status !== 'ready' || !load.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getJournal(load.nextCursor);
      setLoad((prev) =>
        prev.status === 'ready'
          ? { ...prev, entries: [...prev.entries, ...page.data], nextCursor: page.nextCursor }
          : prev,
      );
    } catch {
      // Keep what is shown; a failed extra page is not a reason to blank
      // the journal the person is reading.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="journal-heading" className="card dash-card">
      <div className="dash-card-header">
        <h2 id="journal-heading">Your journal</h2>
      </div>

      <p className="hint">
        A place for whatever you’re carrying. Kept until you delete it, and never used to write your
        devotionals — it’s just for you.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="visually-hidden" htmlFor="journal-draft">
          Write a journal entry
        </label>
        <textarea
          id="journal-draft"
          className="journal-draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Is there something on your mind?"
          rows={3}
          maxLength={4000}
        />
        {saveError && (
          <p className="notice notice-error" role="status">
            {saveError}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving || draft.trim().length === 0}>
          {saving ? 'Saving…' : 'Keep this'}
        </button>
      </form>

      {load.status === 'loading' && (
        <p className="hint" role="status">
          Opening your journal…
        </p>
      )}

      {load.status === 'error' && (
        <div>
          <p className="hint">Your journal didn’t load. You can try again.</p>
          <button type="button" className="secondary" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      )}

      {load.status === 'ready' && load.entries.length === 0 && (
        <p className="hint">Nothing here yet. Whatever you write will stay, in your words.</p>
      )}

      {load.status === 'ready' && load.entries.length > 0 && (
        <ul className="journal-entries">
          {load.entries.map((entry) => (
            <li key={entry.id} className="journal-entry">
              {/* `formatDay` renders the instant in the profile zone, so the
                  date shown matches the day the person actually wrote. */}
              <p className="journal-entry-date hint">{formatDay(entry.createdAt, zone)}</p>
              {/* `white-space: pre-wrap` (in CSS) keeps the line breaks the
                  person typed — a journal that flattens paragraphs is not
                  keeping their words. */}
              <p className="journal-entry-text">{entry.text}</p>
              {pendingDelete === entry.id ? (
                <p className="journal-entry-confirm">
                  <span className="hint">Delete this entry?</span>{' '}
                  <button
                    type="button"
                    className="quiet journal-danger"
                    onClick={() => void confirmDelete(entry.id)}
                  >
                    Delete
                  </button>{' '}
                  <button type="button" className="quiet" onClick={() => setPendingDelete(null)}>
                    Keep
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  className="quiet journal-delete"
                  onClick={() => setPendingDelete(entry.id)}
                  aria-label="Delete this journal entry"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {load.status === 'ready' && load.nextCursor && (
        <button type="button" className="secondary" onClick={() => void showMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show earlier entries'}
        </button>
      )}
    </section>
  );
}
