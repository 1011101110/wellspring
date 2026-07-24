/**
 * The design-token literal, pinned (T1, #348).
 *
 * ## Why these assertions restate hex codes
 *
 * The token values are not this package's invention — they are the §08
 * handoff of the owner's approved design file, copied verbatim. Restating
 * the handoff values here means a "cleanup" that nudges a hex (or a merge
 * that half-applies a palette change) fails against the design document's
 * numbers, not against a snapshot that would have been regenerated along
 * with the mistake. This is the anchored-assertion rule: the fixture must
 * come from the source the code is supposed to match, and the source here
 * is the design handoff, not the code.
 */
import { describe, expect, it } from 'vitest';
import { designTokens, wellspringCssVariables, wellspringTokensCss } from '../src/designTokens.js';

describe('designTokens', () => {
  it('carries the §08 handoff values verbatim', () => {
    expect(designTokens.color.light).toEqual({
      canvas: '#FCF7F2',
      mist: '#F7EADF',
      dawn: '#EFD9C8',
      terracotta: '#B4795A',
      clay: '#8A5F43',
      ink: '#3B322C',
      muted: '#A2937F',
    });
    expect(designTokens.color.dark).toEqual({
      night: '#171D2C',
      dusk: '#242C40',
      candle: '#E7D7A6',
      paper: '#EEEBE2',
    });
    expect(designTokens.gradient.terracotta).toBe('linear-gradient(145deg, #c98a63, #b4795a)');
    expect(designTokens.gradient.verse).toBe('linear-gradient(180deg, #FBF3EC, #F5E6DA)');
    expect(designTokens.radius).toEqual({ card: '24px', pill: '999px' });
    expect(designTokens.shadow.card).toBe('0 12px 30px rgba(146, 104, 73, 0.12)');
    expect(designTokens.shadow.hero).toBe('0 22px 50px rgba(146, 104, 73, 0.16)');
    expect(designTokens.shadow.cta).toBe('0 10px 22px rgba(180, 121, 90, 0.3)');
    expect(designTokens.motion.ease).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(designTokens.motion.durationMs).toBe(900);
  });

  it('keeps the crossfade band and the §03 type-role invariants', () => {
    expect(designTokens.motion.crossfadeMinMs).toBe(700);
    expect(designTokens.motion.crossfadeMaxMs).toBe(1200);
    expect(designTokens.motion.durationMs).toBeGreaterThanOrEqual(700);
    expect(designTokens.motion.durationMs).toBeLessThanOrEqual(1200);
    // Scripture is serif, light, and never sans; chrome is sans.
    expect(designTokens.typeRole.scripture.family).toBe('serif');
    expect(designTokens.typeRole.scripture.weight).toBe(300);
    expect(designTokens.typeRole.scripture.neverSans).toBe(true);
    expect(designTokens.typeRole.prayer.italic).toBe(true);
    expect(designTokens.typeRole.eyebrow.letterSpacing).toBe('0.22em');
    expect(designTokens.typeRole.body.family).toBe('sans');
    // Both stacks self-host with the mandated local fallbacks.
    expect(designTokens.font.serif).toMatch(/^'Spectral', Georgia/);
    expect(designTokens.font.sans).toMatch(/^'Hanken Grotesk', system-ui/);
  });

  it('is deeply frozen — a surface cannot fork the palette at runtime', () => {
    expect(Object.isFrozen(designTokens)).toBe(true);
    expect(Object.isFrozen(designTokens.color.light)).toBe(true);
    expect(Object.isFrozen(designTokens.typeRole.scripture)).toBe(true);
    expect(() => {
      (designTokens.color.light as { canvas: string }).canvas = '#FFFFFF';
    }).toThrow(TypeError);
  });

  it('emits every verbatim handoff variable name in the CSS variable set', () => {
    const names = wellspringCssVariables().map(([name]) => name);
    for (const handoffName of [
      '--ws-canvas',
      '--ws-mist',
      '--ws-dawn',
      '--ws-terracotta',
      '--ws-clay',
      '--ws-ink',
      '--ws-muted',
      '--ws-night',
      '--ws-dusk',
      '--ws-candle',
      '--ws-paper',
      '--ws-serif',
      '--ws-sans',
      '--ws-radius-card',
      '--ws-radius-pill',
      '--ws-shadow',
      '--ws-ease',
      '--ws-dur',
    ]) {
      expect(names).toContain(handoffName);
    }
    // No duplicate names — two declarations of one property is a silent
    // last-one-wins bug in CSS.
    expect(new Set(names).size).toBe(names.length);
  });

  it('renders a parseable :root block with one declaration per variable', () => {
    const css = wellspringTokensCss();
    expect(css).toMatch(/^\/\*/);
    expect(css).toContain(':root {');
    expect(css.trimEnd().endsWith('}')).toBe(true);
    for (const [name, value] of wellspringCssVariables()) {
      expect(css).toContain(`  ${name}: ${value};`);
    }
  });
});
