import { describe, expect, it } from 'vitest';
import { buildAudioStorageFromEnv } from '../../../src/services/audio/audioStorageConfig.js';
import { GcsAudioStorage, LocalFileAudioStorage } from '../../../src/services/audio/audioStorage.js';

/**
 * Regression tests for issue #68 (docs/14 §1.1/§1.4): the deploy YAML sets
 * `AUDIO_BUCKET`, but the pre-fix code only ever read `GCS_AUDIO_BUCKET` —
 * so every deployed environment silently ran ephemeral LocalFileAudioStorage
 * instead of GCS — and the local-storage fallback signing secret was a
 * fixed in-repo string with no fail-closed check for deployed environments.
 */
describe('buildAudioStorageFromEnv', () => {
  describe('bucket selection (docs/14 §1.1)', () => {
    it('selects GcsAudioStorage from AUDIO_BUCKET — the name deploy-api.yml actually sets', () => {
      const result = buildAudioStorageFromEnv({ AUDIO_BUCKET: 'kairos-audio-real-bucket' });
      expect(result.storage).toBeInstanceOf(GcsAudioStorage);
      expect(result.description).toContain('kairos-audio-real-bucket');
      expect(result.description).not.toContain('DEPRECATED');
    });

    it('still honors the deprecated GCS_AUDIO_BUCKET alias, but flags it as deprecated', () => {
      const result = buildAudioStorageFromEnv({ GCS_AUDIO_BUCKET: 'legacy-bucket-name' });
      expect(result.storage).toBeInstanceOf(GcsAudioStorage);
      expect(result.description).toContain('legacy-bucket-name');
      expect(result.description).toContain('DEPRECATED');
    });

    it('prefers AUDIO_BUCKET when both env vars are set', () => {
      const result = buildAudioStorageFromEnv({
        AUDIO_BUCKET: 'correct-bucket',
        GCS_AUDIO_BUCKET: 'stale-bucket',
      });
      expect(result.description).toContain('correct-bucket');
      expect(result.description).not.toContain('stale-bucket');
      expect(result.description).not.toContain('DEPRECATED');
    });

    it('this is the exact regression scenario: deploy-api.yml sets AUDIO_BUCKET only — pre-fix code would have silently fallen back to LocalFileAudioStorage', () => {
      // Simulates the real deployed env: only AUDIO_BUCKET is set (as
      // deploy-api.yml does), no GCS_AUDIO_BUCKET, staging NODE_ENV, and a
      // real signing secret present (also set by deploy, though moot once
      // GCS mode is selected).
      const result = buildAudioStorageFromEnv({
        NODE_ENV: 'staging',
        AUDIO_BUCKET: 'test-audio-bucket',
        AUDIO_SIGNING_SECRET: 'x'.repeat(32),
      });
      expect(result.storage).toBeInstanceOf(GcsAudioStorage);
    });
  });

  describe('local-file mode + fail-closed signing secret (docs/14 §1.4)', () => {
    it('falls back to LocalFileAudioStorage with no bucket set and no deployed NODE_ENV', () => {
      const result = buildAudioStorageFromEnv({});
      expect(result.storage).toBeInstanceOf(LocalFileAudioStorage);
      expect(result.description).toContain('DEV-ONLY FALLBACK');
    });

    it('uses a real AUDIO_SIGNING_SECRET when provided, even outside a deployed env', () => {
      const result = buildAudioStorageFromEnv({ AUDIO_SIGNING_SECRET: 'y'.repeat(20) });
      expect(result.storage).toBeInstanceOf(LocalFileAudioStorage);
      expect(result.description).toContain('signingSecret=from env');
    });

    it('THROWS at construction when NODE_ENV=production, no bucket, and no signing secret — the exact pre-fix vulnerable state', () => {
      expect(() =>
        buildAudioStorageFromEnv({ NODE_ENV: 'production' }),
      ).toThrow(/Refusing to boot/);
    });

    it('THROWS when NODE_ENV=production and the signing secret is present but too short', () => {
      expect(() =>
        buildAudioStorageFromEnv({ NODE_ENV: 'production', AUDIO_SIGNING_SECRET: 'short' }),
      ).toThrow(/too short/);
    });

    it('THROWS when NODE_ENV=staging (deploy-api.yml\'s staging target) under the same conditions', () => {
      expect(() => buildAudioStorageFromEnv({ NODE_ENV: 'staging' })).toThrow(/Refusing to boot/);
    });

    it('does NOT throw when NODE_ENV=production but AUDIO_BUCKET is set (GCS mode doesn\'t need the local signing secret)', () => {
      expect(() =>
        buildAudioStorageFromEnv({ NODE_ENV: 'production', AUDIO_BUCKET: 'prod-bucket' }),
      ).not.toThrow();
    });

    it('does NOT throw when NODE_ENV=production and a strong signing secret is present', () => {
      const result = buildAudioStorageFromEnv({
        NODE_ENV: 'production',
        AUDIO_SIGNING_SECRET: 'z'.repeat(32),
      });
      expect(result.storage).toBeInstanceOf(LocalFileAudioStorage);
    });

    it('does NOT throw in a non-deployed NODE_ENV (e.g. "test" or unset) even with no secret', () => {
      expect(() => buildAudioStorageFromEnv({ NODE_ENV: 'test' })).not.toThrow();
      expect(() => buildAudioStorageFromEnv({})).not.toThrow();
    });

    it('respects LOCAL_AUDIO_DIR and PUBLIC_BASE_URL overrides', () => {
      const result = buildAudioStorageFromEnv({
        LOCAL_AUDIO_DIR: '/tmp/custom-audio',
        PUBLIC_BASE_URL: 'https://example.test',
        AUDIO_SIGNING_SECRET: 'w'.repeat(20),
      });
      expect(result.description).toContain('/tmp/custom-audio');
      expect(result.description).toContain('https://example.test');
    });
  });
});
