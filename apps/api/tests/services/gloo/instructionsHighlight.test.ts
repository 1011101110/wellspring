/**
 * U4 (#357): the honesty-locked highlight-framing line in buildInstructions.
 * The line appears ONLY when a real `highlightedReference` is passed
 * (mutation-checked against the no-highlight control), it names the passage,
 * it keeps the anti-hallucination rule (fetch via get_bible_verse), and it is
 * phrased so it is true under EITHER read scope — never implying Wellspring
 * saw the user's wider Bible activity, and never counting anything (§9).
 */
import { describe, expect, it } from 'vitest';
import {
  NO_SIGNALS_OBSERVED,
  buildInstructions,
  type BuildInstructionsParams,
} from '../../../src/services/gloo/instructionsBuilder.js';

const BASE: BuildInstructionsParams = {
  tradition: 'general',
  translation: 'BSB',
  bands: {
    recovery: 'moderate',
    sleepQuality: 'fair',
    activity: 'moderate',
    busyness: 'moderate',
    communicationLoad: null,
    distressSignal: false,
  },
  signalProvenance: NO_SIGNALS_OBSERVED,
};

describe('buildInstructions — highlight framing (U4 #357)', () => {
  it('emits the framing line naming the passage ONLY when a reference is given', () => {
    const withHighlight = buildInstructions({ ...BASE, highlightedReference: 'JHN.3.16' });
    const without = buildInstructions(BASE);

    expect(withHighlight).toContain('JHN.3.16');
    expect(withHighlight).toMatch(/marked/i);
    // Mutation check: the control (no reference) contains no framing line at
    // all — absent data is never claimed (signalProvenance doctrine).
    expect(without).not.toMatch(/marked/i);
    expect(without).not.toContain('JHN.3.16');
  });

  it('keeps the anti-hallucination rule: the model still fetches the verse via get_bible_verse', () => {
    const out = buildInstructions({ ...BASE, highlightedReference: 'PSA.23.1' });
    expect(out).toContain('get_bible_verse');
  });

  it('honesty: never implies wider Bible activity and never counts highlights (§9)', () => {
    const out = buildInstructions({ ...BASE, highlightedReference: 'JHN.3.16' });
    // The line scopes to this one passage and forbids commenting on anything else.
    expect(out).toMatch(/only to this one passage|only that they marked this one/i);
    // No frequency/tally language anywhere in the emitted line.
    expect(out).not.toMatch(/how many|number of highlights|you highlight a lot|\bstreak\b/i);
  });

  it('a run with no highlight is byte-identical to pre-U4 (control equality)', () => {
    const a = buildInstructions(BASE);
    const b = buildInstructions({ ...BASE, highlightedReference: undefined });
    expect(a).toBe(b);
  });
});
