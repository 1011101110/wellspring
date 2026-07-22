/**
 * `GET /v1/liturgical-season` (N10, #269).
 *
 * Parsed through the shared contract like every other read in this app: a
 * server that started sending a season string this client does not know
 * fails here, on the first request, rather than rendering `undefined`
 * inside the Today card.
 */
import {
  LiturgicalSeasonResponseSchema,
  type LiturgicalSeason,
} from '@kairos/shared-contracts';
import { ApiError, apiFetch } from './client';

/**
 * `null` is a real answer, not a failure: it means the season does not
 * inform this user's devotionals, and the dashboard renders nothing. The
 * distinction from a thrown error matters — an error puts a "Try again" in
 * front of the user, and there is nothing here to retry.
 */
export async function getLiturgicalSeason(): Promise<LiturgicalSeason | null> {
  const result = LiturgicalSeasonResponseSchema.safeParse(
    await apiFetch<unknown>('/v1/liturgical-season'),
  );
  if (!result.success) {
    throw new ApiError(200, 'Wellspring sent the season in a shape this app does not understand.');
  }
  return result.data.data.season;
}
