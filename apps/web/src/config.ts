/**
 * Build-time configuration.
 *
 * The Firebase web config is not a secret — it is a set of public project
 * identifiers that ship in the built bundle regardless. But this is an
 * open-source repository, so it carries **no real project values**: every
 * field is read from the environment, and the fallbacks here are obvious
 * placeholders. The deploy injects the real values from GitHub Actions
 * variables (`VITE_FIREBASE_*`, `VITE_API_BASE_URL`); a contributor points
 * the client at their own Firebase project via `apps/web/.env.local` (see
 * `.env.example` and this workspace's README).
 *
 * `apiKey` is `requiredEnv` (no placeholder) because a real one is needed
 * to talk to Firebase at all, and a fake placeholder would only produce an
 * opaque `auth/invalid-api-key` on the first sign-in click — better to
 * fail loudly at startup naming the missing variable.
 */
function env(key: string, fallback: string): string {
  const value = import.meta.env[key as keyof ImportMetaEnv];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function requiredEnv(key: string): string {
  const value = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${key} is not set. Copy apps/web/.env.example to apps/web/.env.local and fill it in (see apps/web/README.md).`,
    );
  }
  return value;
}

export const firebaseConfig = {
  apiKey: requiredEnv('VITE_FIREBASE_API_KEY'),
  authDomain: env('VITE_FIREBASE_AUTH_DOMAIN', 'your-project.firebaseapp.com'),
  projectId: env('VITE_FIREBASE_PROJECT_ID', 'your-project'),
  appId: env('VITE_FIREBASE_APP_ID', '1:000000000000:web:0000000000000000000000'),
  messagingSenderId: env('VITE_FIREBASE_MESSAGING_SENDER_ID', '000000000000'),
  storageBucket: env('VITE_FIREBASE_STORAGE_BUCKET', 'your-project.firebasestorage.app'),
};

/** The `/v1` API base. Placeholder points at a local dev server; the deploy sets `VITE_API_BASE_URL`. */
export const apiBaseUrl = env('VITE_API_BASE_URL', 'http://localhost:8090');
