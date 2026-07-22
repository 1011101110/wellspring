/**
 * Coming-soon cards (L8, issue #244) — content, never controls.
 *
 * Governed by **docs/05 §9 and principle P7**: "a control that does
 * nothing does not ship". Placeholders are prose. Not a disabled button,
 * not an inert toggle, not a picker that drops its selection, not an input
 * whose value is discarded.
 *
 * ## Why this is a data table and not three JSX blocks
 *
 * Because a table of strings *cannot* contain a control. The renderer
 * (`ComingSoonCards`) takes `title` and `body`, emits an `<h3>` and a
 * `<p>`, and has no branch that could produce a `<button>` — so the policy
 * is enforced by the shape of the data rather than by anyone remembering
 * it during review. A contributor who wants to add an action to one of
 * these has to change the renderer, which is a visible act.
 *
 * ## Every entry names its tracking issue (§9 rule 4)
 *
 * A shipped feature must not be able to leave a stale "coming soon" behind
 * it — that is the #184/#176 stale-marker lesson applied to UI, and a
 * marker whose issue has closed is worse than no marker because it reads
 * as tracked. `issue` is rendered nowhere; it exists so a grep for the
 * issue number lands here the day it closes.
 */
export interface ComingSoon {
  /** Stable React key and grep handle. */
  id: string;
  title: string;
  /** One sentence. If it needs two, the feature is close enough to build. */
  body: string;
  /** Tracking issue. Delete the entry when this closes. */
  issue: number;
}

export const COMING_SOON: readonly ComingSoon[] = [
  {
    id: 'team-devotionals',
    title: 'Team devotionals',
    body: 'One session for your whole team, booked in a gap you all share.',
    // I7 #172 — the invite path exists; the trigger endpoint does not.
    issue: 172,
  },
  {
    id: 'feedback',
    title: 'How was this for you?',
    body: 'A quiet way to tell Wellspring when a devotional landed, so it can learn your shape.',
    // H4 #56 (with #137/#138) — feedback capture.
    issue: 56,
  },
  {
    id: 'voice-preview',
    title: 'Voice preview',
    body: 'Hear a few seconds of each voice before you choose one.',
    // Exists in the iOS spec, unbuilt on web. Tracked with the L8 card work.
    issue: 244,
  },
] as const;
