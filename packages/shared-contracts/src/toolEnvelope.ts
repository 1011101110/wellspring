import { z } from 'zod';

/**
 * Tool-call result envelope — Foundation §4.5. Every tool (get_bible_verse,
 * and any future tool) returns one of these two shapes.
 */
export const CANONICAL_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'AUTH_FAILED',
  'LICENSE_UNAVAILABLE',
  'NO_BIBLES_AVAILABLE',
  'BIBLE_NOT_FOUND',
  'PASSAGE_NOT_FOUND',
  'REFERENCE_OUT_OF_RANGE',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'AUDIO_UNAVAILABLE',
] as const;

export const ToolErrorCodeSchema = z.enum(CANONICAL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolEnvelopeMetaSchema = z
  .object({
    source: z.string().min(1),
    fetched_at: z.string().datetime({ offset: true }),
  })
  .catchall(z.unknown());
export type ToolEnvelopeMeta = z.infer<typeof ToolEnvelopeMetaSchema>;

export function ToolSuccessSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: ToolEnvelopeMetaSchema,
  });
}

export const ToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: ToolErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
  meta: ToolEnvelopeMetaSchema,
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export function ToolEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('ok', [ToolSuccessSchema(dataSchema), ToolErrorSchema]);
}

/** get_bible_verse tool's `data` payload on success. */
export const BibleVerseDataSchema = z.object({
  usfm: z.string().min(1),
  versionId: z.number().int().positive(),
  /** Human-readable reference (e.g. "Matthew 11:28-30") from YouVersion's passage response. */
  reference: z.string().min(1),
  text: z.string().min(1),
  attribution: z.string().min(1),
});
export type BibleVerseData = z.infer<typeof BibleVerseDataSchema>;

export const GetBibleVerseEnvelopeSchema = ToolEnvelopeSchema(BibleVerseDataSchema);
export type GetBibleVerseEnvelope = z.infer<typeof GetBibleVerseEnvelopeSchema>;

/** Canonical get_bible_verse tool definition — Foundation §4.4. One name, one schema. */
export const GET_BIBLE_VERSE_TOOL_NAME = 'get_bible_verse' as const;

export const GetBibleVerseArgsSchema = z.object({
  usfm: z.string().min(1),
  versionId: z.number().int().positive(),
  reason: z.string().optional(),
});
export type GetBibleVerseArgs = z.infer<typeof GetBibleVerseArgsSchema>;
