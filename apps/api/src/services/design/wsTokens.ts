/**
 * Wellspring Design System tokens — the server-rendered surfaces' view of
 * the SHARED token literal (T3 #350 / T4 #351, epic #347; collapsed from
 * the interim local constants per the #347 close-out residual).
 *
 * Every color/radius/shadow/easing/gradient value here DERIVES from
 * `@kairos/shared-contracts` `designTokens` — the single source of truth
 * (T1, #348). This module adds only what is genuinely a server concern:
 * the flat `WS` shape the page renderers interpolate, and the self-hosted
 * @font-face plumbing (file allowlist + CSS) that has no meaning outside
 * apps/api. Do NOT re-introduce literal values here; if a surface needs a
 * value the shared literal lacks, add it THERE (with its rationale) and
 * derive it here. The drift test
 * (apps/api/tests/services/design/wsTokens.test.ts) fails on any key that
 * stops matching the shared literal, mirroring the web side's
 * tokens.css drift test.
 */
import { designTokens } from '@kairos/shared-contracts';

const t = designTokens;

export const WS = {
  // Light (morning) set — §08 handoff, via the shared literal.
  canvas: t.color.light.canvas,
  mist: t.color.light.mist,
  dawn: t.color.light.dawn,
  terracotta: t.color.light.terracotta,
  clay: t.color.light.clay,
  ink: t.color.light.ink,
  muted: t.color.light.muted,
  // Dark (evening/examen) set — §08 handoff, via the shared literal.
  night: t.color.dark.night,
  dusk: t.color.dark.dusk,
  candle: t.color.dark.candle,
  paper: t.color.dark.paper,
  /** `muted`'s AA-passing text role on the dark set (shared `accessible` group). */
  mutedInkDark: t.color.accessible.mutedInkDark,
  radiusCard: t.radius.card,
  radiusPill: t.radius.pill,
  /** Warm-tinted card shadow — §08: never gray. */
  shadow: t.shadow.card,
  /** Hero-scale warm shadow. */
  shadowHero: t.shadow.hero,
  /** CTA shadow (§05 primary CTA spec). */
  shadowCta: t.shadow.cta,
  /** The dark set's glow — candlelight, not a drop shadow. */
  glowDark: t.shadow.glowDark,
  ease: t.motion.ease,
  /** Crossfade duration — §08 allows 700–1200ms; the shared literal pins the default. */
  dur: `${t.motion.durationMs}ms`,
  /** Terracotta gradient (§08) — CTA pills, progress fill, brand circle. */
  gradientTerracotta: t.gradient.terracotta,
  /** The CTA fill on the dark set — candle, with night text. */
  gradientCtaDark: t.gradient.ctaDark,
  /** Verse-block ground (§05 signature component). */
  gradientVerse: t.gradient.verse,
} as const;

/**
 * Type stacks — the shared literal's, verbatim. Spectral / Hanken Grotesk
 * load via the self-hosted @font-face rules below WHEN the woff2 files
 * exist under apps/api/assets/fonts (T1 #348 commits them); the fallback
 * tails keep every page correct without them.
 */
export const WS_SERIF = t.font.serif;
export const WS_SANS = t.font.sans;

/**
 * The font files the /stage/assets/fonts route will serve — matched to the
 * basenames T1 (#348) committed under apps/api/assets/fonts/: latin subsets
 * per Spectral weight/style, and ONE variable-range Hanken file covering
 * 400–600 (declared via a `weight` RANGE below, per @font-face spec).
 */
export const WS_FONT_FACES: ReadonlyArray<{
  family: 'Spectral' | 'Hanken Grotesk';
  /** Single weight, or an inclusive [min, max] range for variable files. */
  weight: number | readonly [number, number];
  style: 'normal' | 'italic';
  file: string;
}> = [
  { family: 'Spectral', weight: 300, style: 'normal', file: 'spectral-300-latin.woff2' },
  { family: 'Spectral', weight: 300, style: 'italic', file: 'spectral-300italic-latin.woff2' },
  { family: 'Spectral', weight: 400, style: 'normal', file: 'spectral-400-latin.woff2' },
  { family: 'Hanken Grotesk', weight: [400, 600], style: 'normal', file: 'hanken-grotesk-400-600-latin.woff2' },
];

/**
 * Self-hosted @font-face CSS shared by the stage and session shells. The
 * URLs are same-origin (`font-src 'self'` in both scopes' CSP — never an
 * external host, epic #347 ground rule 1); `font-display: swap` plus the
 * fallback stacks means a missing file degrades to Georgia/system-ui with
 * no layout breakage and no console-visible error state.
 */
export function wsFontFaceCss(): string {
  return WS_FONT_FACES.map(
    (f) => `@font-face {
    font-family: '${f.family}';
    font-style: ${f.style};
    font-weight: ${Array.isArray(f.weight) ? f.weight.join(' ') : f.weight};
    font-display: swap;
    src: url('/stage/assets/fonts/${f.file}') format('woff2');
  }`,
  ).join('\n  ');
}
