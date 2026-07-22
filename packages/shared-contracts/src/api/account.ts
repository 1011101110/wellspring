import { z } from 'zod';

/**
 * `DELETE /v1/account` response (docs/00_FOUNDATION §11 / iOS
 * `AccountDeletionClient.swift` TODO / docs/14 §4.2 "verify the response
 * contract matches"). No request body — Foundation §10: the verified
 * bearer token IS the account identifier, matching every other
 * authenticated route's "userId from the verified token, never from the
 * request body" rule. iOS's `HTTPAccountDeletionClient` only checks the
 * HTTP status code today (2xx = success), so this schema is intentionally
 * minimal — it exists so a future iOS conformance has a real shared type
 * to assert against instead of "any 2xx", closing the same contract gap
 * class as §1.5/§3.6.
 */
export const AccountDeletionResponseSchema = z.object({
  ok: z.literal(true),
});
export type AccountDeletionResponse = z.infer<typeof AccountDeletionResponseSchema>;
