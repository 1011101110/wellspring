/**
 * The states preview must mirror the real first-run dashboard (N8, #267).
 *
 * ## What actually went wrong, and why a normal test could not catch it
 *
 * #267's headline ("the generator produces nine block kinds, the renderer
 * handles five") turned out to be a mis-derivation — the devotional output
 * is a flat object and `DevotionalDetail` renders every field of it, so
 * nothing is dropped there. The real defect was one layer out: the
 * `StatesPreview` first-run section, which #245 built specifically so a
 * reviewer could judge the empty dashboard *as one screen*, was rendering
 * five of the real nine first-run blocks. So the ordering problems #266
 * fixed, and the buried connect action, survived review — you cannot
 * review a composition you cannot see.
 *
 * A conventional test cannot catch that, because the preview and the
 * dashboard are different files with no shared value: nothing forces them
 * to agree. This is the anti-drift guard #267 was actually reaching for.
 * It reads both sources and fails the build when the dashboard grows a
 * first-run block the preview does not mirror — the same shape as the
 * cross-workspace retention-constant check in #263, and in the spirit of
 * §3.1: the expectation is derived from the real producer (the dashboard
 * source), not from a hand-maintained list that could rot in step with the
 * preview.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync(new URL('../src/views/Dashboard.tsx', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../src/preview/StatesPreview.tsx', import.meta.url), 'utf8');

/** Every `id="…"` the dashboard puts on a CardFrame, minus non-card anchors. */
function dashboardCardIds(source: string): string[] {
  const NON_CARD = new Set(['main', 'first-run-heading', 'devotional-heading']);
  const ids = [...source.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]!);
  return [...new Set(ids)].filter((id) => !NON_CARD.has(id));
}

/**
 * The slice of the preview that is the first-run composition — from its
 * Section heading to the next `<Section`. Scoping to it is the point: the
 * preview renders every card elsewhere too (in the per-state sections), so
 * a whole-file search would pass even if the first-run section itself were
 * still missing half its blocks, which is exactly the bug.
 */
function firstRunSection(source: string): string {
  const start = source.indexOf('First run —');
  expect(start, 'could not find the first-run Section in the preview').toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('<Section', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('first-run preview fidelity (#267)', () => {
  it('mirrors every CardFrame the real dashboard renders', () => {
    const section = firstRunSection(preview);
    for (const id of dashboardCardIds(dashboard)) {
      // The preview namespaces its ids `p-fr-<id>` so they cannot collide
      // with the per-state sections below it.
      expect(
        section,
        `the real dashboard renders a "${id}" card; the preview's first-run section must show a "p-fr-${id}" so the composition can be reviewed`,
      ).toContain(`id="p-fr-${id}"`);
    }
  });

  it('includes the calendar, which the dashboard renders via <CalendarCard>', () => {
    // CalendarCard carries `id="calendar"` inside its own file, so the
    // id-scan above cannot see it — but it is a first-run block (a
    // disconnected user's collapsed calendar, #266) and must be in the
    // composition.
    expect(dashboard).toContain('<CalendarCard');
    expect(firstRunSection(preview)).toContain('id="p-fr-calendar"');
  });

  it('includes the component cards the dashboard renders without a CardFrame id', () => {
    // InviteAddressCard and ComingSoonCards are real first-run blocks with
    // no CardFrame id of their own. The "nine blocks" #267 counted
    // included them; the preview omitted them.
    const section = firstRunSection(preview);
    for (const component of ['InviteAddressCard', 'ComingSoonCards'] as const) {
      expect(dashboard, `precondition: dashboard renders <${component}>`).toContain(
        `<${component}`,
      );
      expect(section, `the preview's first-run section must render <${component}>`).toContain(
        `<${component}`,
      );
    }
  });

  it('previews the journal, which the dashboard renders unconditionally (#268)', () => {
    // JournalCard fetches on mount, so — like CalendarCard — it cannot be
    // dropped into the no-network preview live; it is previewed as static
    // markup in its own section. But it IS a real dashboard card, so the
    // two must not drift: if the dashboard renders it, the preview must
    // show it somewhere. This is the guard that would catch "added a card,
    // forgot the preview" for the journal specifically.
    expect(dashboard, 'precondition: dashboard renders <JournalCard>').toContain('<JournalCard');
    expect(preview, 'the preview must show the journal (its heading) somewhere').toContain(
      'Your journal',
    );
  });

  it('leads with the connect action, matching the real dashboard (#266)', () => {
    // Both must put the connection card before the Today card in first
    // run. If the dashboard's `leadWithConnect` ordering is reverted, or
    // the preview reorders, this catches the divergence.
    const section = firstRunSection(preview);
    const connectAt = section.indexOf('id="p-fr-connection"');
    const todayAt = section.indexOf('id="p-fr-today"');
    expect(connectAt).toBeGreaterThan(-1);
    expect(todayAt).toBeGreaterThan(-1);
    expect(connectAt, 'connect must come before Today in the first-run composition').toBeLessThan(
      todayAt,
    );

    // The dashboard's ordering guarantee lives in `leadWithConnect`.
    expect(dashboard).toContain('leadWithConnect');
  });
});
