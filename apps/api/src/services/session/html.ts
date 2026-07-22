/**
 * Minimal HTML-escaping helper for the session page (EPIC D, issue #31).
 *
 * Every value interpolated into `renderSessionPage.ts` that ultimately
 * traces back to Gloo/LLM output (theme, devotionalBody, prayer,
 * cardSummary, verse fetchedText/attribution, journalingPrompt,
 * actionStep) MUST be passed through `escapeHtml` first — LLM output is
 * untrusted input (docs/04_DATA_PRIVACY_SECURITY.md §5.4: "LLM output is
 * untrusted input: Zod-validated, HTML-escaped on the session page").
 * There is no template-engine auto-escaping here (hand-rolled template
 * literals), so this is the one and only escaping choke point — every
 * call site in renderSessionPage.ts routes untrusted strings through it.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a value for safe use inside a double-quoted HTML attribute. Same rule as escapeHtml — attributes need the same escaping (quote char included). */
export const escapeAttr = escapeHtml;
