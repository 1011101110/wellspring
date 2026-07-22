/**
 * The "+" (L2, issue #238) — generate a devotional for this moment.
 *
 * ## Honest progress, because 20 seconds of spinner is a hang
 *
 * Generation is a Gloo completion plus a TTS synthesis: 15–30 seconds,
 * routinely. #238 and #245 both single this out — "a 20-second silent
 * spinner is indistinguishable from a hang" — so the button reports what
 * is actually happening in stages, with elapsed-time-driven copy.
 *
 * The stages are **honest about being estimates**. They are driven by a
 * timer, not by server progress events (the endpoint is a single
 * request/response and reports no intermediate state), so the copy says
 * what Wellspring is doing rather than claiming a percentage it cannot know.
 * A progress bar would be a fabricated number; a changing sentence is a
 * true statement about the pipeline plus an honest signal of liveness.
 *
 * ## Second press is a success, never an error
 *
 * `alreadyExisted: true` comes back `ok: true` with the existing session.
 * The user asked for today's devotional and today's devotional exists, so
 * they get it — with copy that says so. Rendering an error toast on a
 * press that in fact succeeded is precisely the lying-UI class Epic L's
 * ground rule 1 exists to prevent.
 */
import { useEffect, useRef, useState } from 'react';
import { generateNow } from '../../api/dashboard';
import { describeGenerateOutcome, type GenerateOutcome } from '../../lib/generateNow';

/**
 * What the button says as the seconds pass. Each entry is a true
 * description of a stage the pipeline actually has.
 */
const STAGES: readonly { after: number; label: string }[] = [
  { after: 0, label: 'Finding a passage…' },
  { after: 6, label: 'Writing your devotional…' },
  { after: 14, label: 'Recording the audio…' },
  // Past the expected window. Says so plainly instead of implying a
  // freeze — the user deserves to know it is running long but alive.
  { after: 30, label: 'Still working — this one is taking a little longer…' },
];

function stageLabel(elapsedSeconds: number): string {
  let label = STAGES[0]!.label;
  for (const stage of STAGES) if (elapsedSeconds >= stage.after) label = stage.label;
  return label;
}

export function GenerateNowButton({ onGenerated }: { onGenerated: (o: GenerateOutcome) => void }) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  async function press() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setElapsed(0);
    timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);

    try {
      // Honest copy for a real, non-error outcome — see `lib/generateNow`.
      const outcome = describeGenerateOutcome(await generateNow());
      if (outcome.note) setNote(outcome.note);
      onGenerated(outcome);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Wellspring could not make a devotional just now. Please try again in a moment.',
      );
    } finally {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="generate-now">
      <button
        type="button"
        className="generate-now-button"
        onClick={() => void press()}
        disabled={busy}
        /*
         * The visible label is a "+" glyph, so the accessible name has to
         * come from here — and it names the action, not the shape.
         * `aria-hidden` on the glyph stops "plus" being read as well.
         */
        aria-label="Make a devotional now"
      >
        <span aria-hidden="true">+</span>
      </button>

      {/*
       * Progress lives in a live region so it is announced as it changes,
       * not merely painted. `aria-live="polite"` rather than assertive:
       * this is expected, user-initiated work, and it should not interrupt
       * whatever the user is reading while they wait.
       */}
      <p className="hint generate-now-status" role="status" aria-live="polite">
        {busy ? stageLabel(elapsed) : (note ?? '')}
      </p>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
