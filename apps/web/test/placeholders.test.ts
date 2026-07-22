/**
 * The placeholder policy, enforced (L8 #244; docs/05 §9 and principle P7).
 *
 * #244's acceptance asks for "a grep-level check (or lint rule) that no
 * placeholder card contains an interactive element". This is that check.
 * It reads the renderer's source and asserts the absence of every
 * interactive construct — which is a stronger guarantee than reviewing the
 * rendered output, because it fails for a control that is added but not
 * yet reachable.
 *
 * The deeper failure mode — a control that looks complete, calls
 * something, and has no observable effect — is explicitly *not* catchable
 * here (docs/05 §9, "Why this is a design principle and not a lint rule").
 * That one is caught by asserting observable output changes, per #193.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMING_SOON } from '../src/lib/placeholders';

const RENDERER = fileURLToPath(
  new URL('../src/components/dashboard/ComingSoonCards.tsx', import.meta.url),
);

describe('coming-soon content', () => {
  it('is prose only — every entry is a title and one sentence', () => {
    for (const item of COMING_SOON) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.body.length).toBeGreaterThan(0);
      // One sentence. Two means the feature is close enough to build.
      expect(item.body.split('.').filter((s) => s.trim().length > 0)).toHaveLength(1);
    }
  });

  it('names a tracking issue for every entry, so none can go stale unnoticed', () => {
    // The #184/#176 stale-marker lesson: a marker whose issue has closed
    // is worse than no marker, because it reads as tracked.
    for (const item of COMING_SOON) {
      expect(Number.isInteger(item.issue)).toBe(true);
      expect(item.issue).toBeGreaterThan(0);
    }
  });

  it('carries no interactive affordance in its data', () => {
    // The table is strings and a number. There is no href, no action, no
    // handler — so the renderer has nothing it *could* wire up.
    for (const item of COMING_SOON) {
      expect(Object.keys(item).sort()).toEqual(['body', 'id', 'issue', 'title']);
    }
  });

  it('uses unique ids, since they are React keys', () => {
    expect(new Set(COMING_SOON.map((i) => i.id)).size).toBe(COMING_SOON.length);
  });
});

describe('the coming-soon renderer', () => {
  const source = readFileSync(RENDERER, 'utf8');

  // Comments legitimately discuss buttons and inputs (that is the whole
  // policy), so they are stripped before the markup is checked.
  const markup = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('renders no interactive element of any kind', () => {
    for (const tag of ['<button', '<input', '<select', '<textarea', '<a ', '<form']) {
      expect(markup).not.toContain(tag);
    }
  });

  it('wires no event handler and no disabled control', () => {
    // "Disabled with an explanation" is reserved for real-but-blocked
    // (docs/05 §9 rule 3) — not for features that do not exist.
    expect(markup).not.toMatch(/onClick|onChange|onSubmit|disabled/);
  });

  it('does not render the issue number to the user', () => {
    // `issue` is a grep handle for maintainers, not UI. A user does not
    // benefit from a bug number on their dashboard.
    expect(markup).not.toContain('item.issue');
  });
});
