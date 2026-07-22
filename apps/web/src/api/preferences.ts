/**
 * `GET`/`PUT /v1/preferences` — the single door to all cross-surface user
 * state (#225: preferences, consent columns, and `onboardedAt` all ride
 * this one call, so a client cannot end up half-loaded).
 *
 * Responses are parsed with the *shared* `PreferencesResponseSchema`
 * rather than cast. The contract package is the same one the server
 * validates against, so a drift between the two shows up here as a parse
 * failure on the very first request instead of as an `undefined` several
 * components later.
 */
import {
  PreferencesResponseSchema,
  type PreferencesResponseData,
  type PreferencesUpdateRequest,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';

function parse(payload: unknown): PreferencesResponseData {
  const result = PreferencesResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new ApiError(200, 'Wellspring sent settings in a shape this app does not understand.');
  }
  return result.data.data;
}

export async function getPreferences(): Promise<PreferencesResponseData> {
  return parse(await apiFetch<unknown>('/v1/preferences'));
}

export async function putPreferences(
  body: PreferencesUpdateRequest,
): Promise<PreferencesResponseData> {
  // PUT returns the same payload shape as GET (including a re-read
  // `onboardedAt`), so the caller applies either response identically and
  // never needs a follow-up GET to learn what actually landed.
  return parse(await apiFetch<unknown>('/v1/preferences', { method: 'PUT', body }));
}
