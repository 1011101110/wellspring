/**
 * Theological QA gate sample generator (docs/07_TEST_PLAN.md §4, issue
 * #47): produces LIVE devotionals — real Gloo + real YouVersion, no
 * fixtures — sampled across every format x every tradition, plus one
 * distress-signal case per tradition, for the pre-submission rubric
 * review. The grid was N=20 (4 traditions); adding `anglican`/`orthodox`
 * in #192 makes it N=30 (6 traditions x 4 formats + 6 distress cells),
 * which is the point of capping the enum — each added value costs a whole
 * column of live QA. Text-only (no TTS, no DB, no session) — the rubric reviews
 * devotional content, not audio/session plumbing, so this stays a pure
 * two-API script to keep the live-call surface minimal.
 *
 * Usage (repo root):
 *   set -a; source .env; set +a
 *   npx tsx apps/api/scripts/qaGridSample.ts > /tmp/qa-grid-sample.json
 *
 * Requires GLOO_CLIENT_ID, GLOO_CLIENT_SECRET, YOUVERSION_API_KEY.
 */
import { GlooTokenManager } from '../src/services/gloo/glooTokenManager.js';
import { GlooResponsesClient } from '../src/services/gloo/glooResponsesClient.js';
import { YouVersionClient } from '../src/services/youversion/youVersionClient.js';
import { DevotionalEngine, type GenerateDevotionalResult } from '../src/services/devotionalEngine.js';
import { TraditionSchema } from '@kairos/shared-contracts';
import type { BandInput, DevotionalFormat, Tradition } from '@kairos/shared-contracts';

const TRANSLATION_ID = 3034; // BSB — Foundation §4.3 default.
/**
 * Derived from the schema rather than hand-listed (#192): this grid is the
 * theological-QA gate, so a tradition missing from it is a tradition that
 * ships without rubric review. Reading `TraditionSchema.options` makes that
 * structurally impossible — a new enum value joins the grid automatically.
 */
const TRADITIONS: readonly Tradition[] = TraditionSchema.options;
const FORMATS: DevotionalFormat[] = ['micro', 'short', 'standard', 'extended'];

/** Rotate through varied, plausible band combinations so the grid isn't all-identical bands. */
const BAND_ROTATION: Omit<BandInput, 'distressSignal'>[] = [
  { recovery: 'low', sleepQuality: 'poor', activity: 'sedentary', busyness: 'heavy', communicationLoad: 'heavy' },
  { recovery: 'moderate', sleepQuality: 'fair', activity: 'moderate', busyness: 'moderate', communicationLoad: 'moderate' },
  { recovery: 'high', sleepQuality: 'good', activity: 'active', busyness: 'light', communicationLoad: 'light' },
  { recovery: 'moderate', sleepQuality: 'poor', activity: 'sedentary', busyness: 'heavy', communicationLoad: null },
];

interface GridCell {
  id: string;
  tradition: Tradition;
  format?: DevotionalFormat; // explicit durationPreference override; omitted for the distress cells (format forced by distressSignal)
  distressSignal: boolean;
  bands: BandInput;
}

function buildGrid(): GridCell[] {
  const cells: GridCell[] = [];
  let bandIdx = 0;

  // 24 cells (6 traditions x 4 formats): every (tradition x format) combo, non-distress, format chosen via explicit durationPreference override.
  for (const tradition of TRADITIONS) {
    for (const format of FORMATS) {
      const rotation = BAND_ROTATION[bandIdx % BAND_ROTATION.length]!;
      bandIdx += 1;
      cells.push({
        id: `${tradition}-${format}`,
        tradition,
        format,
        distressSignal: false,
        bands: { ...rotation, distressSignal: false },
      });
    }
  }

  // 6 cells: one distress-signal case per tradition (format forced to 'micro' by the engine regardless of any override).
  for (const tradition of TRADITIONS) {
    const rotation = BAND_ROTATION[bandIdx % BAND_ROTATION.length]!;
    bandIdx += 1;
    cells.push({
      id: `${tradition}-distress`,
      tradition,
      distressSignal: true,
      bands: { ...rotation, distressSignal: true },
    });
  }

  return cells;
}

interface CellResult {
  id: string;
  tradition: Tradition;
  distressSignal: boolean;
  bands: BandInput;
  requestedFormat: DevotionalFormat | 'auto (distress -> micro)';
  ok: boolean;
  source?: GenerateDevotionalResult['source'];
  toolCallsExecuted?: number;
  devotional?: GenerateDevotionalResult['devotional'];
  error?: string;
}

async function main() {
  const glooClientId = process.env.GLOO_CLIENT_ID ?? '';
  const glooClientSecret = process.env.GLOO_CLIENT_SECRET ?? '';
  const youVersionApiKey = process.env.YOUVERSION_API_KEY ?? '';
  if (!glooClientId || !glooClientSecret || !youVersionApiKey) {
    console.error('Missing GLOO_CLIENT_ID / GLOO_CLIENT_SECRET / YOUVERSION_API_KEY in environment.');
    process.exit(1);
  }

  const glooTokenManager = new GlooTokenManager({ clientId: glooClientId, clientSecret: glooClientSecret });
  const glooResponsesClient = new GlooResponsesClient({
    getAccessToken: () => glooTokenManager.getToken(),
    invalidateToken: () => glooTokenManager.invalidate(),
  });
  const youVersionClient = new YouVersionClient({ apiKey: youVersionApiKey });
  const engine = new DevotionalEngine({ glooResponsesClient, youVersionClient });

  const grid = buildGrid();
  const results: CellResult[] = [];

  for (const cell of grid) {
    process.stderr.write(`Generating ${cell.id}...\n`);
    try {
      const result = await engine.generate({
        bands: cell.bands,
        tradition: cell.tradition,
        translation: 'BSB',
        preferredVersionId: TRANSLATION_ID,
        durationPreference: cell.format,
      });
      results.push({
        id: cell.id,
        tradition: cell.tradition,
        distressSignal: cell.distressSignal,
        bands: cell.bands,
        requestedFormat: cell.format ?? 'auto (distress -> micro)',
        ok: true,
        source: result.source,
        toolCallsExecuted: result.toolCallsExecuted,
        devotional: result.devotional,
      });
    } catch (err) {
      results.push({
        id: cell.id,
        tradition: cell.tradition,
        distressSignal: cell.distressSignal,
        bands: cell.bands,
        requestedFormat: cell.format ?? 'auto (distress -> micro)',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, results }, null, 2));

  const failures = results.filter((r) => !r.ok);
  const repaired = results.filter((r) => r.source === 'gloo_repaired');
  const fixtureFallback = results.filter((r) => r.source === 'fixture');
  process.stderr.write(
    `\nDone: ${results.length} cells, ${failures.length} threw, ${repaired.length} needed hallucination repair, ${fixtureFallback.length} fell back to fixture.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
