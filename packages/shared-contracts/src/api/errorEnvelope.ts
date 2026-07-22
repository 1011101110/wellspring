import { z } from 'zod';

/**
 * Generic error envelope every `/v1/*` and session route already uses
 * ad hoc (`{ ok: false, error: { code, message, retryable } }` — see
 * `auth/middleware.ts`'s 401, `routes/userScoped.ts`'s 404,
 * `app.ts`'s 429 `errorResponseBuilder`). Docs/14 §2.9 / issue #72 adds a
 * global Fastify `setErrorHandler` that must emit this SAME shape for
 * every uncaught error (including raw pg failures) — this schema is the
 * one place that shape is pinned so the handler and any test asserting
 * on it share a single source of truth.
 *
 * `code` is deliberately `z.string()`, not the tool-envelope's
 * `ToolErrorCodeSchema` (toolEnvelope.ts) — that enum is scoped to
 * Gloo/YouVersion tool-call failures (Foundation §4.5); HTTP-layer errors
 * use a different, broader vocabulary (`AUTH_FAILED`, `NOT_FOUND`,
 * `RATE_LIMITED`, `INTERNAL_ERROR`, ...) and there is no value in forcing
 * one enum to cover both call sites.
 */
export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** The one message ever sent for an unexpected/uncaught server error — never `error.message` from the underlying exception (docs/14 §2.9). */
export const GENERIC_INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred. Please try again.';
