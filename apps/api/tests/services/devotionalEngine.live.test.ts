/**
 * Live-integration tests for DevotionalEngine against the REAL Gloo Responses
 * API and REAL YouVersion Platform API — no mocks anywhere in this file.
 *
 * Skipped entirely (describe.skipIf) when GLOO_CLIENT_ID/GLOO_CLIENT_SECRET/
 * YOUVERSION_API_KEY are not present — CI has no .env and must skip
 * gracefully, not fail. Run locally with:
 *   set -a; source .env; set +a; npm --workspace apps/api run test -- devotionalEngine.live
 *
 * This is the "wow" end-to-end path (issue #19): bands + preferences in,
 * a real, theologically-reasonable DevotionalOutput with real fetched
 * Scripture text out. Findings are also posted to issue #20 (live-contract
 * burn-down spike).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlooResponsesClient } from '../../src/services/gloo/glooResponsesClient.js';
import { GlooTokenManager } from '../../src/services/gloo/glooTokenManager.js';
import { YouVersionClient } from '../../src/services/youversion/youVersionClient.js';
import { DevotionalEngine } from '../../src/services/devotionalEngine.js';
import type { BandInput } from '@kairos/shared-contracts';

const glooClientId = process.env.GLOO_CLIENT_ID;
const glooClientSecret = process.env.GLOO_CLIENT_SECRET;
const youVersionApiKey = process.env.YOUVERSION_API_KEY;

const hasLiveCreds = Boolean(glooClientId && glooClientSecret && youVersionApiKey);

const BSB = 3034;

const LOW_POOR_HEAVY: BandInput = {
  recovery: 'low',
  sleepQuality: 'poor',
  activity: 'sedentary',
  busyness: 'heavy',
  communicationLoad: 'moderate',
  distressSignal: false,
};

const HIGH_GOOD_LIGHT: BandInput = {
  recovery: 'high',
  sleepQuality: 'good',
  activity: 'active',
  busyness: 'light',
  communicationLoad: 'light',
  distressSignal: false,
};

describe.skipIf(!hasLiveCreds)('DevotionalEngine — LIVE (real Gloo + real YouVersion)', () => {
  let engine: DevotionalEngine;

  beforeAll(() => {
    const tokenManager = new GlooTokenManager({
      clientId: glooClientId ?? '',
      clientSecret: glooClientSecret ?? '',
    });
    const glooResponsesClient = new GlooResponsesClient({
      getAccessToken: () => tokenManager.getToken(),
    });
    const youVersionClient = new YouVersionClient({ apiKey: youVersionApiKey ?? '' });
    engine = new DevotionalEngine({ glooResponsesClient, youVersionClient });
  }, 30_000);

  it(
    'generates a real, valid, non-fixture devotional for low_poor_heavy (under-rested + packed calendar)',
    async () => {
      const result = await engine.generate({
        bands: LOW_POOR_HEAVY,
        tradition: 'general',
        translation: 'BSB',
        preferredVersionId: BSB,
      });

      // eslint-disable-next-line no-console
      console.log('\n=== LIVE low_poor_heavy devotional ===\n', JSON.stringify(result, null, 2));

      expect(['gloo', 'gloo_repaired']).toContain(result.source);
      expect(result.devotional.verses.length).toBeGreaterThan(0);
      for (const verse of result.devotional.verses) {
        expect(verse.fetchedText.length).toBeGreaterThan(0);
        expect(verse.attribution.length).toBeGreaterThan(0);
        expect(verse.versionId).toBeGreaterThan(0);
      }
      expect(result.devotional.devotionalBody.length).toBeGreaterThan(0);
      expect(result.devotional.cardSummary.length).toBeLessThanOrEqual(300);
      expect(result.devotional.prayer.length).toBeGreaterThan(0);
      // Format heuristic: recovery=low + busyness=heavy -> micro or short (Foundation §5).
      expect(['micro', 'short']).toContain(result.devotional.format);
    },
    120_000,
  );

  it(
    'generates a real, valid, non-fixture devotional for high_good_light (rested + open afternoon)',
    async () => {
      const result = await engine.generate({
        bands: HIGH_GOOD_LIGHT,
        tradition: 'evangelical',
        translation: 'BSB',
        preferredVersionId: BSB,
      });

      // eslint-disable-next-line no-console
      console.log('\n=== LIVE high_good_light devotional ===\n', JSON.stringify(result, null, 2));

      expect(['gloo', 'gloo_repaired']).toContain(result.source);
      expect(result.devotional.verses.length).toBeGreaterThan(0);
      for (const verse of result.devotional.verses) {
        expect(verse.fetchedText.length).toBeGreaterThan(0);
        expect(verse.attribution.length).toBeGreaterThan(0);
      }
      // Format heuristic: busyness=light + recovery=high -> extended (Foundation §5).
      expect(result.devotional.format).toBe('extended');
    },
    120_000,
  );

  it(
    'generates a real devotional for a distress check-in that stays gentle, micro, and non-alarming',
    async () => {
      const result = await engine.generate({
        bands: { ...LOW_POOR_HEAVY, distressSignal: true },
        tradition: 'general',
        translation: 'BSB',
        preferredVersionId: BSB,
      });

      // eslint-disable-next-line no-console
      console.log('\n=== LIVE distress-signal devotional ===\n', JSON.stringify(result, null, 2));

      expect(['gloo', 'gloo_repaired']).toContain(result.source);
      // Safety floor: distressSignal=true always forces micro (Foundation §5, §9).
      expect(result.devotional.format).toBe('micro');

      const bodyLower = result.devotional.devotionalBody.toLowerCase();
      const bannedPhrases = ['you have anxiety', 'you are depressed', 'diagnos', 'your fault', 'you failed'];
      for (const phrase of bannedPhrases) {
        expect(bodyLower).not.toContain(phrase);
      }
    },
    120_000,
  );
});
