/**
 * Drift test for the server-rendered surfaces' tokens (epic #347 residual:
 * the interim wsTokens module collapsed into the shared literal).
 *
 * Mirrors the web side's idiom (apps/web/test/designTokens.test.ts): the
 * web checks its checked-in tokens.css byte-for-byte against the shared
 * generator AND re-parses the declarations back out of the file; here the
 * "generated output" is the `--ws-*` declarations the stage/session page
 * renderers actually emit, so the parse step runs against REAL rendered
 * pages. Any hex re-hardcoded in wsTokens.ts, or a page variable that
 * stops matching `@kairos/shared-contracts` designTokens, fails with the
 * exact name in the message. The shared literal always wins (#347).
 *
 * Also pins the evening/examen contrast pairs (T3 #350 residual) from the
 * shared tokens themselves — the same "a11y wins over literal fidelity"
 * rule (#347 rule 2) the light surfaces already carry, measured here so a
 * future token nudge cannot silently drop a pairing below WCAG AA.
 */
import { describe, expect, it } from 'vitest';
import { designTokens, wellspringCssVariables } from '@kairos/shared-contracts';
import { WS, WS_SANS, WS_SERIF, wsFontFaceCss } from '../../../src/services/design/wsTokens.js';
import { renderSessionPage } from '../../../src/services/session/renderSessionPage.js';
import { renderStagePage } from '../../../src/services/stage/renderStagePage.js';

const t = designTokens;

const PAGE = {
  token: '00000000-0000-4000-8000-000000000001',
  completed: false,
  audioUrl: null,
  devotional: {
    theme: 'Rest',
    format: 'short',
    verses: [
      {
        usfm: 'MAT.11.28',
        reference: 'Matthew 11:28',
        fetchedText: 'Come to me, all you who are weary.',
        attribution: 'Berean Standard Bible',
      },
    ],
    devotionalBody: 'body',
    prayer: 'prayer',
    journalingPrompt: null,
    actionStep: null,
  },
};

/** One declaration per line — the same parse the web drift test performs on tokens.css. */
function parseWsDeclarations(html: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const line of html.split('\n')) {
    const match = /^\s+(--ws-[\w-]+): (.+);$/.exec(line);
    if (match) declarations.set(match[1]!, match[2]!);
  }
  return declarations;
}

describe('wsTokens — derives every value from the shared designTokens literal', () => {
  it('each WS entry IS the shared value (re-hardcoding any literal here fails against the source)', () => {
    expect(WS.canvas).toBe(t.color.light.canvas);
    expect(WS.mist).toBe(t.color.light.mist);
    expect(WS.dawn).toBe(t.color.light.dawn);
    expect(WS.terracotta).toBe(t.color.light.terracotta);
    expect(WS.clay).toBe(t.color.light.clay);
    expect(WS.ink).toBe(t.color.light.ink);
    expect(WS.muted).toBe(t.color.light.muted);
    expect(WS.night).toBe(t.color.dark.night);
    expect(WS.dusk).toBe(t.color.dark.dusk);
    expect(WS.candle).toBe(t.color.dark.candle);
    expect(WS.paper).toBe(t.color.dark.paper);
    expect(WS.mutedInkDark).toBe(t.color.accessible.mutedInkDark);
    expect(WS.radiusCard).toBe(t.radius.card);
    expect(WS.radiusPill).toBe(t.radius.pill);
    expect(WS.shadow).toBe(t.shadow.card);
    expect(WS.shadowHero).toBe(t.shadow.hero);
    expect(WS.shadowCta).toBe(t.shadow.cta);
    expect(WS.glowDark).toBe(t.shadow.glowDark);
    expect(WS.ease).toBe(t.motion.ease);
    expect(WS.dur).toBe(`${t.motion.durationMs}ms`);
    expect(WS.gradientTerracotta).toBe(t.gradient.terracotta);
    expect(WS.gradientCtaDark).toBe(t.gradient.ctaDark);
    expect(WS.gradientVerse).toBe(t.gradient.verse);
    expect(WS_SERIF).toBe(t.font.serif);
    expect(WS_SANS).toBe(t.font.sans);
  });

  it('the @font-face rules stay same-origin (epic #347 ground rule 1)', () => {
    const css = wsFontFaceCss();
    expect(css).toContain("src: url('/stage/assets/fonts/");
    expect(css).not.toMatch(/https?:\/\//);
  });
});

describe('rendered pages — every emitted --ws-* variable matches the shared literal', () => {
  const stageHtml = renderStagePage({
    page: PAGE,
    token: '00000000-0000-4000-8000-000000000001',
    manifest: null,
    muted: false,
    slotType: 'standard',
  });
  const sessionHtml = renderSessionPage(PAGE);
  const shared = new Map(wellspringCssVariables());

  for (const [surface, html, mustEmit] of [
    [
      'stage',
      stageHtml,
      // The stage needs both palettes (its evening variant is a CSS
      // override block that is always present) plus motion.
      [
        '--ws-canvas',
        '--ws-mist',
        '--ws-dawn',
        '--ws-terracotta',
        '--ws-clay',
        '--ws-ink',
        '--ws-night',
        '--ws-dusk',
        '--ws-candle',
        '--ws-paper',
        '--ws-muted-ink-dark',
        '--ws-ease',
        '--ws-dur',
      ],
    ],
    ['session', sessionHtml, ['--ws-canvas', '--ws-mist', '--ws-terracotta', '--ws-clay', '--ws-ink']],
  ] as const) {
    it(`${surface} page declarations, parsed back out of the rendered CSS, all equal the shared values`, () => {
      const declarations = parseWsDeclarations(html);
      expect(declarations.size).toBeGreaterThan(0);
      for (const [name, value] of declarations) {
        expect(shared.get(name), `${surface} emits ${name} but the shared literal has no such variable`).toBeDefined();
        expect(value, name).toBe(shared.get(name));
      }
      for (const name of mustEmit) {
        expect(declarations.has(name), `${surface} must emit ${name}`).toBe(true);
      }
    });
  }

  it('stage role variables carry the shared shadows/gradients verbatim (light AND evening blocks)', () => {
    expect(stageHtml).toContain(`--stage-shadow: ${t.shadow.card};`);
    expect(stageHtml).toContain(`--stage-shadow-hero: ${t.shadow.hero};`);
    expect(stageHtml).toContain(`--stage-cta-shadow: ${t.shadow.cta};`);
    expect(stageHtml).toContain(`--stage-shadow: ${t.shadow.glowDark};`);
    expect(stageHtml).toContain(`--stage-cta-bg: ${t.gradient.terracotta};`);
    expect(stageHtml).toContain(`--stage-cta-bg: ${t.gradient.ctaDark};`);
  });

  it('session page carries the shared verse gradient and warm shadow verbatim', () => {
    expect(sessionHtml).toContain(t.gradient.verse);
    expect(sessionHtml).toContain(t.shadow.card);
  });
});

/** WCAG 2.x relative-luminance contrast ratio for two #RRGGBB values. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const channels = [0, 2, 4].map((i) => parseInt(hex.slice(1).slice(i, i + 2), 16) / 255);
    const [r, g, b] = channels.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('evening/examen palette — small-text pairings hold WCAG AA 4.5:1 (T3 #350 residual)', () => {
  const { night, dusk, candle, paper } = t.color.dark;
  const { mutedInkDark } = t.color.accessible;

  it.each([
    ['candle accent text on night ground', candle, night], // measured 11.75:1
    ['candle accent text on dusk surfaces', candle, dusk], // 9.72:1
    ['paper text on night ground', paper, night], // 14.11:1
    ['paper text on dusk surfaces (caption chip)', paper, dusk], // 11.67:1
    ['dark muted-ink secondary text on night', mutedInkDark, night], // 7.39:1
    ['dark muted-ink secondary text on dusk', mutedInkDark, dusk], // 6.12:1
    ['night label text on the candle CTA (dark end)', night, candle], // 11.75:1
    ['night label text on the candle CTA (light end)', night, '#EFE2B8'], // 13.01:1
  ])('%s ≥ 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
