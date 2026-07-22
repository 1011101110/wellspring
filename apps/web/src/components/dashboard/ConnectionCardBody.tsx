/**
 * Calendar health at a glance (L10, issue #246).
 *
 * The state comes from `deriveConnectionState`, a pure function of the
 * `GET /v1/connections` payload — never from local state. That is #213
 * made structural: the iOS disconnect button lied because the status it
 * displayed was device memory rather than the server's row, and this
 * component has no parameter through which a local guess could enter.
 *
 * **No disconnect here.** #246 puts destructive calendar actions in
 * settings, behind the confirmation flow #213 added. A connected user sees
 * no button on this card at all — `connectionActionLabel` returns `null`
 * for `active` — rather than a disabled one (docs/05 P7).
 */
import type { ConnectionState } from '../../lib/connectionState';
import { CONNECTION_COPY, connectionActionLabel } from '../../lib/connectionState';
import { formatDay } from '../../lib/datetime';

export function ConnectionCardBody({
  state,
  zone,
  onConnect,
}: {
  state: ConnectionState;
  zone: string;
  onConnect: () => void;
}) {
  const copy = CONNECTION_COPY[state.kind];
  const actionLabel = connectionActionLabel(state);

  return (
    <>
      {/* State in words, not a coloured dot — the 1.4.1 rule this codebase
          already holds in Settings and the weekday circles. */}
      <p className="readout">{copy.title}</p>
      <p className="hint">{copy.body}</p>

      {state.kind === 'active' && state.connection.connectedAt && (
        <p className="hint">Connected since {formatDay(state.connection.connectedAt, zone)}.</p>
      )}

      {actionLabel && (
        <button type="button" className="secondary" onClick={onConnect}>
          {actionLabel}
        </button>
      )}
    </>
  );
}
