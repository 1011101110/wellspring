/**
 * Opening a past devotional, and playing it (L5, issue #241).
 *
 * ## Replay is authenticated, not a resurrected capability token
 *
 * Session pages are capability-token surfaces and their audio is a GCS
 * signed URL with a 15-minute expiry, so a week-old session link is not a
 * replay path — the token and the URL have both long since aged out.
 * #241's fix is the authenticated re-open: `GET /v1/devotionals/:id`
 * proves ownership, and `GET /v1/devotionals/:id/audio` mints a *fresh*
 * signed URL on each request. That is why this view fetches audio
 * separately at open time rather than expecting a playable URL on the
 * devotional row. Widening capability-token lifetimes instead would have
 * enlarged #79's surface for every session ever issued.
 *
 * `audio_object` on the detail row is a storage object name, not a URL,
 * and is never used to build one here.
 *
 * ## AUDIO_UNAVAILABLE is a state, not an error
 *
 * Retention purges audio (#82) while the text remains. The API answers
 * `404 AUDIO_UNAVAILABLE`, `retryable: false`, and `getDevotionalAudio`
 * turns that into `null`. This view then renders the devotional with a
 * sentence explaining the audio is gone — never a player that cannot play,
 * and never a "try again" for a file that is not coming back.
 */
import { useEffect, useState } from 'react';
import type { DevotionalDetail as DevotionalDetailData } from '@kairos/shared-contracts';
import { getDevotional, getDevotionalAudio } from '../api/devotionals';
import { audioExpiryNotice, audioLifetime } from '../lib/audioRetention';
import { formatCalendarDate } from '../lib/datetime';
import { ErrorNote } from './Onboarding';

type AudioState =
  | { status: 'loading' }
  /** A fresh signed URL, good for the next few minutes. */
  | { status: 'ready'; url: string }
  /** Purged, never synthesized, or otherwise terminally absent. */
  | { status: 'unavailable' }
  | { status: 'error' };

export function DevotionalDetailView({
  devotionalId,
  onBack,
  /** Set when this was opened by a second "+" press — see `GenerateNowButton`. */
  alreadyExistedNote,
}: {
  devotionalId: string;
  onBack: () => void;
  alreadyExistedNote?: string | null;
}) {
  const [devotional, setDevotional] = useState<DevotionalDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<AudioState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setDevotional(null);
    setError(null);
    setAudio({ status: 'loading' });

    getDevotional(devotionalId)
      .then((data) => {
        if (live) setDevotional(data);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'We could not open this devotional.');
      });

    /*
     * Fetched in parallel with the text, not after it: the words are the
     * substance and should paint as soon as they arrive, rather than
     * waiting on a signed-URL round trip that may end in "unavailable"
     * anyway.
     */
    getDevotionalAudio(devotionalId)
      .then((data) => {
        if (!live) return;
        setAudio(data ? { status: 'ready', url: data.url } : { status: 'unavailable' });
      })
      .catch(() => {
        if (live) setAudio({ status: 'error' });
      });

    return () => {
      live = false;
    };
  }, [devotionalId]);

  return (
    <section aria-labelledby="devotional-heading" className="card">
      <button type="button" className="quiet" onClick={onBack}>
        Back to your dashboard
      </button>

      {alreadyExistedNote && (
        <p className="notice notice-ok" role="status">
          {alreadyExistedNote}
        </p>
      )}

      <ErrorNote message={error} />

      {!devotional && !error && (
        <p className="hint" role="status">
          Opening…
        </p>
      )}

      {devotional && (
        <>
          <h1 id="devotional-heading">{devotional.theme}</h1>
          {/* A calendar day, not an instant — see `formatCalendarDate`. */}
          <p className="hint">{formatCalendarDate(devotional.date)}</p>

          {/* Announced when the audio question settles, so a screen-reader
              user is not left waiting on a player that is never coming. */}
          <p className="visually-hidden" role="status">
            {audio.status === 'ready'
              ? 'Audio is ready to play.'
              : audio.status === 'unavailable'
                ? 'Audio is no longer available for this devotional. The text is below.'
                : ''}
          </p>

          {audio.status === 'loading' && <p className="hint">Preparing the audio…</p>}

          {audio.status === 'ready' && (
            /*
             * No <track> caption element: the full text of the devotional
             * is rendered directly below this player, which is the same
             * content the audio speaks. That is a better transcript than a
             * generated caption file would be, and it is available to
             * everyone rather than only to players that surface captions.
             */
            <audio className="devotional-audio" controls src={audio.url} preload="none">
              Your browser cannot play audio. The devotional is written out below.
            </audio>
          )}

          {/*
           * #263: say it before it happens. Only renders in the last few
           * days, so it is a courtesy rather than furniture under every
           * devotional. See `audioRetention.ts` for why only this half of
           * #263 is implemented here.
           */}
          {audio.status === 'ready' &&
            (() => {
              const notice = audioExpiryNotice(
                audioLifetime(devotional.date, new Date()),
                formatCalendarDate,
              );
              return notice ? <p className="hint">{notice}</p> : null;
            })()}

          {audio.status === 'unavailable' && (
            <p className="hint">
              The audio for this devotional is no longer available. The words are all here.
            </p>
          )}

          {audio.status === 'error' && (
            <p className="hint">
              Wellspring could not load the audio just now. The words are all here.
            </p>
          )}

          {devotional.verses.map((verse) => (
            <blockquote key={verse.usfm} className="verse">
              <p>{verse.fetchedText}</p>
              <cite>
                {verse.reference} — {verse.attribution}
              </cite>
            </blockquote>
          ))}

          {/*
            The body is plain prose from the generator, rendered as
            paragraphs rather than dangerously-set HTML — the text is
            model-generated and must never be treated as markup.

            An index key is correct here: this list is derived from one
            immutable string and is never reordered, filtered, or appended
            to, which is precisely the case where index keys are stable.
          */}
          {devotional.devotional_body
            .split('\n')
            .filter((paragraph) => paragraph.trim().length > 0)
            .map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}

          <h2>Prayer</h2>
          <p>{devotional.prayer}</p>

          {devotional.journaling_prompt && (
            <>
              <h2>To sit with</h2>
              <p>{devotional.journaling_prompt}</p>
            </>
          )}

          {devotional.action_step && (
            <>
              <h2>One step</h2>
              <p>{devotional.action_step}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
