/**
 * Env-driven AudioStorage selection — issue #68 (docs/14 §1.1/§1.4).
 *
 * Extracted from src/index.ts so the selection + fail-closed rules are unit
 * testable without booting the process (index.ts connects the DB pool and
 * binds a port at import time).
 *
 * Rules:
 *   - `AUDIO_BUCKET` (the name deploy-api.yml sets) selects GcsAudioStorage.
 *     `GCS_AUDIO_BUCKET` is honored as a DEPRECATED alias — the pre-#68 code
 *     read only that name while the deploy set AUDIO_BUCKET, so every
 *     deployed environment silently fell back to ephemeral local-file
 *     storage (docs/14 §1.1).
 *   - No bucket → LocalFileAudioStorage. In deployed environments
 *     (NODE_ENV=production or staging) this REQUIRES a real
 *     AUDIO_SIGNING_SECRET (≥16 chars): the old fallback to an in-repo
 *     constant let anyone with repo access forge audio tokens for any
 *     deployment booted without the secret (docs/14 §1.4). Fail closed at
 *     boot instead. The dev-only fallback constant remains for local
 *     `npm run dev` / docker-compose convenience ONLY outside those envs.
 */

import {
  GcsAudioStorage,
  LocalFileAudioStorage,
  type AudioStorage,
} from './audioStorage.js';

/** Matches LocalFileAudioStorage's own constructor check — keep in sync. */
const MIN_SIGNING_SECRET_LENGTH = 16;

const DEV_ONLY_SIGNING_SECRET = 'dev-only-audio-signing-secret-change-me';

export interface AudioStorageSelection {
  storage: AudioStorage;
  /**
   * One-line human-readable summary for the boot log (docs/14 §1.1 fix:
   * "a boot-time log line that states which storage implementation was
   * selected"). Never contains secrets.
   */
  description: string;
}

/**
 * Builds the process's AudioStorage from environment variables. Throws (=>
 * refuse to boot) when a deployed environment would otherwise run with the
 * public in-repo signing secret.
 */
export function buildAudioStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AudioStorageSelection {
  const bucketName = env.AUDIO_BUCKET ?? env.GCS_AUDIO_BUCKET;
  if (bucketName) {
    const viaDeprecatedAlias = !env.AUDIO_BUCKET;
    return {
      storage: new GcsAudioStorage({ bucketName }),
      description: `GcsAudioStorage (bucket=${bucketName}${
        viaDeprecatedAlias ? ', via DEPRECATED GCS_AUDIO_BUCKET — set AUDIO_BUCKET instead' : ''
      })`,
    };
  }

  // Local-file mode. NODE_ENV=staging is deployed too (deploy-api.yml sets
  // it for the kairos-api-staging target), so it gets the same fail-closed
  // treatment as production.
  const nodeEnv = env.NODE_ENV;
  const deployed = nodeEnv === 'production' || nodeEnv === 'staging';
  const secret = env.AUDIO_SIGNING_SECRET;
  const secretUsable = typeof secret === 'string' && secret.length >= MIN_SIGNING_SECRET_LENGTH;

  if (deployed && !secretUsable) {
    throw new Error(
      `Refusing to boot: NODE_ENV=${nodeEnv} selected LocalFileAudioStorage (no AUDIO_BUCKET set) ` +
        `but AUDIO_SIGNING_SECRET is ${secret ? `too short (< ${MIN_SIGNING_SECRET_LENGTH} chars)` : 'missing'}. ` +
        `The in-repo dev fallback secret must never sign tokens in a deployed environment ` +
        `(anyone with repo access could forge audio URLs — docs/14 §1.4). ` +
        `Set AUDIO_BUCKET (preferred, GCS mode) or provide a strong AUDIO_SIGNING_SECRET.`,
    );
  }

  const rootDir = env.LOCAL_AUDIO_DIR ?? '.data/audio';
  const baseUrl = env.PUBLIC_BASE_URL;
  return {
    storage: new LocalFileAudioStorage({
      rootDir,
      signingSecret: secretUsable ? (secret as string) : DEV_ONLY_SIGNING_SECRET,
      baseUrl,
    }),
    description: `LocalFileAudioStorage (rootDir=${rootDir}, baseUrl=${baseUrl ?? 'http://localhost:8080 (default)'}, signingSecret=${secretUsable ? 'from env' : 'DEV-ONLY FALLBACK'})`,
  };
}
