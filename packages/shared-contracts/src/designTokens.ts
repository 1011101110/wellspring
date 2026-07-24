/**
 * Wellspring Design System tokens — the single source of truth (T1, #348).
 *
 * Extracted verbatim from the owner's approved design file (claude.ai/design
 * project 1b3fe422, "Wellspring Design System.dc.html", §08 handoff). The web
 * CSS custom properties AND the server-rendered page renderers must derive
 * from THIS literal — if a surface and this file disagree, this file wins.
 *
 * ## The `accessible` group
 *
 * The design's own ground rule (#347 rule 2) is that accessibility wins over
 * literal fidelity: where a verbatim pairing fails WCAG AA at its size, the
 * ROLE is kept and the shade adjusted. Those derived shades live here too, so
 * the adjustment is made once, in the open, rather than re-invented (or
 * skipped) per surface. Measured ratios are noted beside each value.
 *
 * ## Frozen, deliberately
 *
 * A token set something can mutate at runtime is not a source of truth.
 * `deepFreeze` makes every level of the literal immutable, so a surface that
 * tries to "adjust" a token throws in development instead of silently forking
 * the palette.
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const designTokens = deepFreeze({
  color: {
    /** The light (morning) surface set — §08 handoff, verbatim. */
    light: {
      canvas: '#FCF7F2',
      mist: '#F7EADF',
      dawn: '#EFD9C8',
      /** The ONLY accent, used sparingly (§08). */
      terracotta: '#B4795A',
      clay: '#8A5F43',
      ink: '#3B322C',
      muted: '#A2937F',
    },
    /** The dark (evening) surface set — §08 handoff, verbatim. */
    dark: {
      night: '#171D2C',
      dusk: '#242C40',
      candle: '#E7D7A6',
      paper: '#EEEBE2',
    },
    /**
     * Same roles, AA-passing shades (#347 rule 2). Each entry names the
     * verbatim token whose role it carries and why it exists.
     */
    accessible: {
      /**
       * `muted`'s role for text. #A2937F measures 2.81:1 on canvas — below
       * even the 3:1 large-text bar — so muted TEXT uses this deepened
       * warm-stone instead (5.64:1 on canvas, 4.41:1 on dawn). The verbatim
       * `muted` stays available for non-text uses.
       */
      mutedInk: '#6F614E',
      /** `muted`'s text role on the dark set (6.12:1 on dusk, 7.39:1 on night). */
      mutedInkDark: '#B4AB9A',
      /**
       * A deepened clay for focus rings and small accents where clay itself
       * sits on mid-warm grounds (6.13:1 on canvas, 4.80:1 on dawn).
       */
      clayDeep: '#7C5539',
      /** `terracotta`'s accent role on the dark set (7.44:1 on night, 6.15:1 on dusk). */
      terracottaLight: '#D9A07F',
    },
  },
  gradient: {
    /**
     * The signature terracotta gradient — verbatim. DECORATIVE fills only
     * (brand mark, large glyphs ≥24px): white small text on the light end
     * measures 2.88:1.
     */
    terracotta: 'linear-gradient(145deg, #c98a63, #b4795a)',
    /**
     * The terracotta gradient's role on text-bearing pill CTAs, deepened
     * into the clay range so white 15px/600 label text passes AA at every
     * point (4.84:1 light end, 5.53:1 dark end).
     */
    cta: 'linear-gradient(145deg, #96674B, #8A5F43)',
    /** The CTA fill on the dark set — candle, with night text (11.75:1). */
    ctaDark: 'linear-gradient(145deg, #EFE2B8, #E7D7A6)',
    /** The verse block ground (§05 signature components). */
    verse: 'linear-gradient(180deg, #FBF3EC, #F5E6DA)',
  },
  radius: {
    card: '24px',
    pill: '999px',
  },
  shadow: {
    /** THE shadow — warm-tinted, never gray (§08). */
    card: '0 12px 30px rgba(146, 104, 73, 0.12)',
    hero: '0 22px 50px rgba(146, 104, 73, 0.16)',
    /** Under the primary pill CTA (§05). */
    cta: '0 10px 22px rgba(180, 121, 90, 0.3)',
    /** The dark set's glow — candlelight, not a drop shadow. */
    glowDark: '0 0 60px rgba(217, 200, 155, 0.35)',
  },
  motion: {
    ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
    /** The standard crossfade duration. */
    durationMs: 900,
    /** Crossfades live in this band; nothing springs or bounces (§08). */
    crossfadeMinMs: 700,
    crossfadeMaxMs: 1200,
    /** The breathing orb's loop. */
    breathMs: 7000,
  },
  font: {
    /** Spectral, self-hosted — scripture, prayer, titles. Georgia is the local fallback. */
    serif: "'Spectral', Georgia, 'Times New Roman', serif",
    /** Hanken Grotesk, self-hosted — all UI chrome. NEVER serif for chrome (§03). */
    sans: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  glass: {
    background: 'rgba(255, 255, 255, 0.55)',
    blur: '12px',
    border: '1px solid rgba(255, 255, 255, 0.7)',
  },
  /**
   * Type roles as data (§03). `family` names a key of `font`; sizes are the
   * role's px band (a single-size role repeats the value). These are specs
   * for surfaces to render from, not CSS variables.
   */
  typeRole: {
    scripture: {
      family: 'serif',
      weight: 300,
      italic: false,
      minSizePx: 26,
      maxSizePx: 36,
      lineHeight: 1.4,
      /** §03: scripture is NEVER set in sans. */
      neverSans: true,
    },
    prayer: {
      family: 'serif',
      weight: 300,
      italic: true,
      minSizePx: 22,
      maxSizePx: 26,
      lineHeight: 1.4,
    },
    reference: {
      family: 'sans',
      weight: 500,
      italic: false,
      minSizePx: 13,
      maxSizePx: 13,
      lineHeight: 1.4,
    },
    eyebrow: {
      family: 'sans',
      weight: 600,
      italic: false,
      minSizePx: 12,
      maxSizePx: 12,
      lineHeight: 1.2,
      letterSpacing: '0.22em',
      uppercase: true,
    },
    title: {
      family: 'serif',
      weight: 400,
      italic: false,
      minSizePx: 26,
      maxSizePx: 52,
      lineHeight: 1.25,
      letterSpacing: '-0.01em',
    },
    body: {
      family: 'sans',
      weight: 400,
      italic: false,
      minSizePx: 14,
      maxSizePx: 16,
      lineHeight: 1.6,
    },
  },
} as const);

export type DesignTokens = typeof designTokens;

/**
 * The `--ws-*` custom properties the web's `tokens.css` is generated from,
 * in emission order. Names given verbatim in the §08 handoff (`--ws-canvas`
 * … `--ws-dur`) keep those names exactly; derived values get derived names.
 */
export function wellspringCssVariables(): ReadonlyArray<readonly [string, string]> {
  const t = designTokens;
  return [
    ['--ws-canvas', t.color.light.canvas],
    ['--ws-mist', t.color.light.mist],
    ['--ws-dawn', t.color.light.dawn],
    ['--ws-terracotta', t.color.light.terracotta],
    ['--ws-clay', t.color.light.clay],
    ['--ws-ink', t.color.light.ink],
    ['--ws-muted', t.color.light.muted],
    ['--ws-night', t.color.dark.night],
    ['--ws-dusk', t.color.dark.dusk],
    ['--ws-candle', t.color.dark.candle],
    ['--ws-paper', t.color.dark.paper],
    ['--ws-muted-ink', t.color.accessible.mutedInk],
    ['--ws-muted-ink-dark', t.color.accessible.mutedInkDark],
    ['--ws-clay-deep', t.color.accessible.clayDeep],
    ['--ws-terracotta-light', t.color.accessible.terracottaLight],
    ['--ws-grad-terracotta', t.gradient.terracotta],
    ['--ws-grad-cta', t.gradient.cta],
    ['--ws-grad-cta-dark', t.gradient.ctaDark],
    ['--ws-grad-verse', t.gradient.verse],
    ['--ws-radius-card', t.radius.card],
    ['--ws-radius-pill', t.radius.pill],
    ['--ws-shadow', t.shadow.card],
    ['--ws-shadow-hero', t.shadow.hero],
    ['--ws-shadow-cta', t.shadow.cta],
    ['--ws-glow-dark', t.shadow.glowDark],
    ['--ws-ease', t.motion.ease],
    ['--ws-dur', `${t.motion.durationMs}ms`],
    ['--ws-serif', t.font.serif],
    ['--ws-sans', t.font.sans],
    ['--ws-glass-bg', t.glass.background],
    ['--ws-glass-blur', t.glass.blur],
    ['--ws-glass-border', t.glass.border],
  ];
}

/**
 * The exact content of the web's checked-in `apps/web/src/tokens.css`.
 * Regenerate with `npm run tokens --workspace=apps/web`; the drift test in
 * `apps/web/test/designTokens.test.ts` fails if the file and this function
 * ever disagree.
 */
export function wellspringTokensCss(): string {
  const lines = wellspringCssVariables()
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return [
    '/*',
    ' * GENERATED from @kairos/shared-contracts designTokens.ts — do not edit.',
    ' * Regenerate: npm run tokens --workspace=apps/web',
    ' */',
    ':root {',
    lines,
    '}',
    '',
  ].join('\n');
}
