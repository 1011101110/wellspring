/**
 * Thin wrapper around the Cloud KMS REST API for encrypting/decrypting
 * OAuth2 refresh tokens at rest (Architecture §2.4, Foundation §10).
 *
 * Uses direct Cloud KMS REST API (not @google-cloud/kms — that package is
 * not installed) authenticated with ADC via google-auth-library.
 *
 * Encryption model (MVP): KMS envelope — no local AES-GCM layer.
 * The connections table's `encryption_iv` / `encryption_auth_tag` columns
 * exist in the schema but hold empty buffers for now. A future migration
 * can add a local AES-GCM layer on top of KMS without changing the API.
 */

import { GoogleAuth } from 'google-auth-library';

const KMS_BASE = 'https://cloudkms.googleapis.com/v1';

export interface GoogleKmsServiceDeps {
  /**
   * Full CryptoKey resource name, e.g.
   * "projects/<project>/locations/us-central1/keyRings/kairos/cryptoKeys/token-encryption"
   */
  keyName: string;
  /** Returns a fresh bearer token valid for cloudkms.googleapis.com (injectable for tests). */
  getAccessToken: () => Promise<string>;
}

export class GoogleKmsService {
  private readonly keyName: string;
  private readonly getAccessToken: () => Promise<string>;

  constructor(deps: GoogleKmsServiceDeps) {
    this.keyName = deps.keyName;
    this.getAccessToken = deps.getAccessToken;
  }

  /**
   * Encrypts `plaintext` with the Cloud KMS key.
   *
   * @returns ciphertext (Buffer) and the full CryptoKeyVersion resource name
   *          from the response — store this as `kms_key_version` so decrypt
   *          can use the same key version (KMS key rotation safety).
   */
  async encryptToken(plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: string }> {
    const token = await this.getAccessToken();
    const url = `${KMS_BASE}/${this.keyName}:encrypt`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plaintext: Buffer.from(plaintext).toString('base64'),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`KMS encrypt failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as { ciphertext: string; name: string };
    return {
      ciphertext: Buffer.from(data.ciphertext, 'base64'),
      keyVersion: data.name, // full CryptoKeyVersion resource name
    };
  }

  /**
   * Decrypts `ciphertext` using the Cloud KMS key.
   *
   * The decrypt endpoint operates on the CryptoKey (not a specific version) —
   * Cloud KMS resolves the correct version automatically from the ciphertext
   * metadata, so we use `this.keyName` (the CryptoKey path) here.
   */
  async decryptToken(ciphertext: Buffer): Promise<string> {
    const token = await this.getAccessToken();
    const url = `${KMS_BASE}/${this.keyName}:decrypt`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ciphertext: ciphertext.toString('base64'),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`KMS decrypt failed: HTTP ${response.status} — ${text}`);
    }

    const data = (await response.json()) as { plaintext: string };
    return Buffer.from(data.plaintext, 'base64').toString();
  }
}

/**
 * Constructs a GoogleKmsService from environment variables.
 *
 * KMS_KEY_NAME: full CryptoKey resource name
 * (`projects/PROJECT/locations/REGION/keyRings/RING/cryptoKeys/KEY`).
 * Required — no default, because a hardcoded fallback would put a real
 * project's resource path in this open-source repo. The deploy sets it
 * (built from the project/region it deploys to); local dev with calendar
 * OAuth sets it in `.env`.
 *
 * Authentication: Application Default Credentials via google-auth-library,
 * scoped to Cloud KMS — works on Cloud Run (workload identity / SA key) and
 * locally (gcloud auth application-default login or GOOGLE_APPLICATION_CREDENTIALS).
 */
export function buildGoogleKmsServiceFromEnv(): GoogleKmsService {
  const keyName = process.env.KMS_KEY_NAME;
  if (!keyName) {
    throw new Error(
      'KMS_KEY_NAME is not set. It must be the full CryptoKey resource name ' +
        '(projects/…/locations/…/keyRings/…/cryptoKeys/…). The deploy sets it; ' +
        'for local calendar-OAuth work, add it to your .env.',
    );
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloudkms'],
  });

  const getAccessToken = async (): Promise<string> => {
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse.token) throw new Error('KMS: could not obtain access token from ADC');
    return tokenResponse.token;
  };

  return new GoogleKmsService({ keyName, getAccessToken });
}
