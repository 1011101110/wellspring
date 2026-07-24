import type { YouVersionSettingsState } from '../lib/youversionConnection';
import { youVersionConnectedLabel } from '../lib/youversionConnection';
import type { YouVersionCallbackResult } from '../lib/youversionCallback';

/**
 * "Connected accounts" (U5, kairos-devotional#358): the Settings card that
 * connects a YouVersion account and holds the two highlight-consent toggles.
 * A sibling of the rhythm card (#327) — same `fieldset.field` idiom, same
 * "state in words, never color alone" a11y posture, same #244 rule that an
 * unusable state renders NOTHING rather than a dead control.
 *
 * It is deliberately presentational and prop-driven (no `useState`, no
 * `sessionStorage`): everything it shows comes from the server-authoritative
 * slices the shell passes down, so the card can never claim a connection the
 * server did not report — the #213/#225 discipline the calendar card follows.
 * The one-shot callback banner is read from `sessionStorage` by `SettingsView`
 * and handed in as `callback`, keeping this component pure and previewable.
 *
 * §07 voice: the consent copy is plain and honest about scope, and the
 * `honesty line` states the hard limit — Wellspring reads and adds highlights
 * and nothing else — which is exactly the scope U1 requests, kept truthful.
 */

/** §07 consent copy — pinned by test so a reword is a deliberate, reviewed act. */
export const YOUVERSION_WRITE_COPY =
  'After each devotional, save its verse to your YouVersion highlights.';
export const YOUVERSION_READ_COPY =
  "Let Wellspring notice verses you've highlighted and gently weave them in.";

/** The honesty line (§07): what Wellspring can never see or do. */
export const YOUVERSION_HONESTY_LINE =
  'Wellspring only reads and adds highlights — never your notes, plans, or anything else.';

/** The graceful "not configured yet" (503) note — no error, just "coming soon". */
export const YOUVERSION_UNAVAILABLE_NOTE =
  'Connecting your YouVersion account is coming soon.';

export function ConnectedAccountsCard({
  state,
  unavailable,
  busy,
  writeHighlights,
  readHighlights,
  callback,
  onConnect,
  onDisconnect,
  onToggleWrite,
  onToggleRead,
}: {
  /** The server-derived state (`youVersionSettingsState`). `unsupported` → render nothing. */
  state: YouVersionSettingsState;
  /**
   * The connect endpoint answered `503` (not configured yet — staging until
   * U1). The row is shown disabled with a quiet "coming soon" note rather than
   * an error. Only meaningful in the `not_connected` state.
   */
  unavailable: boolean;
  busy: boolean;
  /** `yvWriteHighlights` from the last preferences response. */
  writeHighlights: boolean;
  /** `yvReadHighlights` from the last preferences response. */
  readHighlights: boolean;
  /** The one-shot OAuth return banner, or null. Read from sessionStorage by the parent. */
  callback: YouVersionCallbackResult | null;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Persists `yvWriteHighlights` immediately via a SPARSE PUT (never the staged form). */
  onToggleWrite: (next: boolean) => void;
  /** Persists `yvReadHighlights` immediately via a SPARSE PUT (never the staged form). */
  onToggleRead: (next: boolean) => void;
}) {
  // Older server that does not report YouVersion status at all: render
  // nothing, not a placeholder control that cannot work (#244).
  if (state.kind === 'unsupported') return null;

  return (
    <fieldset className="field">
      <legend>Connected accounts</legend>

      {/* The OAuth return, surfaced quietly (§07) — a status line, not a
          screaming toast. Success is calm confirmation; a failure is worded
          as something to try again, never as an accusation. */}
      {callback && (
        <p
          className={`notice ${callback.status === 'success' ? 'notice-ok' : 'notice-warn'}`}
          role="status"
        >
          {callback.status === 'success'
            ? 'Your YouVersion account is connected.'
            : callback.message}
        </p>
      )}

      {/* The provider name as the eyebrow label — state is carried in words
          below, never by a colored dot (the same 1.4.1 rule the rhythm and
          calendar rows follow). */}
      <p className="readout">YouVersion</p>

      {state.kind === 'not_connected' ? (
        unavailable ? (
          <>
            {/* Not configured yet (503). Disabled, with a "coming soon" note
                rather than an error crash — the row still reads as a real,
                future capability. */}
            <button type="button" className="secondary" disabled>
              Sign in with YouVersion
            </button>
            <p className="hint">{YOUVERSION_UNAVAILABLE_NOTE}</p>
          </>
        ) : (
          <>
            <p className="hint">
              Connect your YouVersion account to save and gently reuse highlighted verses.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={onConnect}
              disabled={busy}
            >
              Sign in with YouVersion
            </button>
          </>
        )
      ) : (
        <>
          {/* A sentence, not an eyebrow label — `rhythm-status` opts out of
              the uppercase `.readout` treatment so a name reads as a name. */}
          <p className="readout rhythm-status">{youVersionConnectedLabel(state.displayName)}</p>

          {/* Consent toggles: shown only once connected, both default off, and
              each persists on its own via a sparse PUT (the parent wires
              `onToggle*` to `sparseSave` — never the staged form). */}
          <label className="row" htmlFor="settings-yv-write">
            <input
              id="settings-yv-write"
              type="checkbox"
              checked={writeHighlights}
              disabled={busy}
              onChange={(e) => onToggleWrite(e.target.checked)}
            />
            <span>{YOUVERSION_WRITE_COPY}</span>
          </label>

          <label className="row" htmlFor="settings-yv-read">
            <input
              id="settings-yv-read"
              type="checkbox"
              checked={readHighlights}
              disabled={busy}
              onChange={(e) => onToggleRead(e.target.checked)}
            />
            <span>{YOUVERSION_READ_COPY}</span>
          </label>

          <button type="button" className="quiet" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </button>
        </>
      )}

      {/* The hard limit, stated plainly — true of both states, so always
          shown (§07 honesty; matches the scope U1 actually requests). */}
      <p className="hint">{YOUVERSION_HONESTY_LINE}</p>
    </fieldset>
  );
}
