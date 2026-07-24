/**
 * Wellspring Design System tokens — INTERIM local constants for the
 * server-rendered surfaces (T3 #350 / T4 #351, epic #347).
 *
 * NOTE: interim — collapse into shared designTokens.ts when #348 merges
 * (the cross-package drift test lives there). Do NOT add new consumers of
 * this module outside apps/api's server-rendered pages; import the shared
 * package once it exists.
 *
 * Values are verbatim from the owner's design ("Wellspring Design
 * System.dc.html", §08 handoff): canvas/mist/dawn grounds, terracotta as
 * the ONLY accent, warm-tinted shadows (never gray), Spectral for
 * scripture/prayer/titles and Hanken Grotesk for UI chrome.
 */

export const WS = {
  canvas: '#FCF7F2',
  mist: '#F7EADF',
  dawn: '#EFD9C8',
  terracotta: '#B4795A',
  clay: '#8A5F43',
  ink: '#3B322C',
  muted: '#A2937F',
  night: '#171D2C',
  dusk: '#242C40',
  candle: '#E7D7A6',
  paper: '#EEEBE2',
  radiusCard: '24px',
  radiusPill: '999px',
  /** Warm-tinted card shadow — §08: never gray. */
  shadow: '0 12px 30px rgba(146,104,73,.12)',
  /** Hero-scale warm shadow. */
  shadowHero: '0 22px 50px rgba(146,104,73,.16)',
  /** CTA shadow (§05 primary CTA spec). */
  shadowCta: '0 10px 22px rgba(180,121,90,.3)',
  ease: 'cubic-bezier(.4,0,.2,1)',
  /** Crossfade duration — §08 allows 700–1200ms; 900ms is the token default. */
  dur: '900ms',
  /** Terracotta gradient (§08) — CTA pills, progress fill, brand circle. */
  gradientTerracotta: 'linear-gradient(145deg,#c98a63,#b4795a)',
  /** Verse-block ground (§05 signature component). */
  gradientVerse: 'linear-gradient(180deg,#FBF3EC,#F5E6DA)',
} as const;

/**
 * Type stacks. Spectral / Hanken Grotesk load via the self-hosted
 * @font-face rules below WHEN the woff2 files exist under
 * apps/api/assets/fonts (T1 #348 commits them); the fallbacks keep every
 * page correct without them (Georgia/Iowan serif, system-ui sans).
 */
export const WS_SERIF =
  `'Spectral', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif`;
export const WS_SANS =
  `'Hanken Grotesk', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;

/**
 * The font files the /stage/assets/fonts route will serve when present.
 * SEAM (T1 #348): these names must match the woff2 files T1 commits under
 * apps/api/assets/fonts/ — if T1 lands different basenames, update this
 * list and the @font-face src URLs below (one place each).
 */
export const WS_FONT_FACES: ReadonlyArray<{
  family: 'Spectral' | 'Hanken Grotesk';
  weight: number;
  style: 'normal' | 'italic';
  file: string;
}> = [
  { family: 'Spectral', weight: 300, style: 'normal', file: 'Spectral-Light.woff2' },
  { family: 'Spectral', weight: 300, style: 'italic', file: 'Spectral-LightItalic.woff2' },
  { family: 'Spectral', weight: 400, style: 'normal', file: 'Spectral-Regular.woff2' },
  { family: 'Hanken Grotesk', weight: 400, style: 'normal', file: 'HankenGrotesk-Regular.woff2' },
  { family: 'Hanken Grotesk', weight: 500, style: 'normal', file: 'HankenGrotesk-Medium.woff2' },
  { family: 'Hanken Grotesk', weight: 600, style: 'normal', file: 'HankenGrotesk-SemiBold.woff2' },
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
    font-weight: ${f.weight};
    font-display: swap;
    src: url('/stage/assets/fonts/${f.file}') format('woff2');
  }`,
  ).join('\n  ');
}
