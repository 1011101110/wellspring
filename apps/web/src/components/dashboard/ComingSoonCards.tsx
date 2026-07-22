/**
 * Coming-soon cards (L8, issue #244) — the renderer that *cannot* emit a
 * control.
 *
 * Governed by docs/05 §9 and principle P7. This component takes
 * `COMING_SOON` — a table of two strings and an issue number — and emits a
 * heading and a paragraph. There is no `onClick` parameter, no `href`, no
 * children slot, and no branch that could produce a `<button>`, a
 * `<input>`, or an `<a>`. The policy is enforced by the component's shape
 * rather than by anyone remembering it in review, which is the whole point
 * of §9: the seven dead preferences (#193) and the lying disconnect button
 * (#213) were each written by someone reasonable who intended to wire it
 * up later.
 *
 * The `<aside>` wrapper is deliberate: this is complementary content, not
 * part of the dashboard's functional flow, and it lands accordingly in the
 * screen-reader landmark order — after everything a user can actually act
 * on.
 */
import { COMING_SOON } from '../../lib/placeholders';

export function ComingSoonCards() {
  return (
    <aside aria-labelledby="coming-soon-heading" className="card dash-card dash-coming-soon">
      <h2 id="coming-soon-heading">Coming to Wellspring</h2>
      <p className="hint">These are being built. Nothing here is switched on yet.</p>

      <dl className="priming">
        {COMING_SOON.map((item) => (
          <div key={item.id}>
            <dt>{item.title}</dt>
            <dd>{item.body}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
