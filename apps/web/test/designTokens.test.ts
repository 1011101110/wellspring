/**
 * Drift test for the checked-in tokens.css (T1, #348).
 *
 * `src/tokens.css` is generated from the token literal in
 * `@kairos/shared-contracts` and committed, so no build step sits between
 * the tokens and the stylesheets that consume them. The cost of checking in
 * generated output is that it can drift from its source; this test is that
 * cost, paid once: byte-for-byte equality with the generator's output, so
 * ANY divergence — an edited hex, a hand-added variable, a stale file after
 * a token change — fails here with a diff.
 *
 * It also re-parses the file's declarations and compares each against the
 * TS literal independently of the generator, so a bug in
 * `wellspringTokensCss` itself (emitting a wrong value while agreeing with
 * the file it generated) cannot hide behind the equality check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  designTokens,
  wellspringCssVariables,
  wellspringTokensCss,
} from '@kairos/shared-contracts';

const tokensCss = readFileSync(join(__dirname, '..', 'src', 'tokens.css'), 'utf8');

describe('tokens.css', () => {
  it('is byte-for-byte the generator output — regenerate with `npm run tokens --workspace=apps/web`', () => {
    expect(tokensCss).toBe(wellspringTokensCss());
  });

  it('declares exactly the TS literal values, parsed back out of the CSS', () => {
    // One declaration per line inside :root — parse them all.
    const declarations = new Map<string, string>();
    for (const line of tokensCss.split('\n')) {
      const match = /^\s{2}(--ws-[\w-]+):\s(.+);$/.exec(line);
      if (match) declarations.set(match[1]!, match[2]!);
    }

    const expected = wellspringCssVariables();
    expect(declarations.size).toBe(expected.length);
    for (const [name, value] of expected) {
      expect(declarations.get(name), name).toBe(value);
    }

    // Spot-check the pins the design handoff names verbatim against the
    // literal itself, so this test still means something if the variable
    // list and the file were somehow regenerated together with a bad value.
    expect(declarations.get('--ws-canvas')).toBe(designTokens.color.light.canvas);
    expect(declarations.get('--ws-terracotta')).toBe(designTokens.color.light.terracotta);
    expect(declarations.get('--ws-ink')).toBe(designTokens.color.light.ink);
    expect(declarations.get('--ws-night')).toBe(designTokens.color.dark.night);
    expect(declarations.get('--ws-radius-card')).toBe(designTokens.radius.card);
    expect(declarations.get('--ws-shadow')).toBe(designTokens.shadow.card);
    expect(declarations.get('--ws-ease')).toBe(designTokens.motion.ease);
    expect(declarations.get('--ws-dur')).toBe(`${designTokens.motion.durationMs}ms`);
    expect(declarations.get('--ws-serif')).toBe(designTokens.font.serif);
    expect(declarations.get('--ws-sans')).toBe(designTokens.font.sans);
  });
});
