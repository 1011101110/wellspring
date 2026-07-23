import { z } from 'zod';

/**
 * End-of-session feedback (EPIC P #312, story #320): the ≤10-second,
 * all-optional feedback moment on the post-Amen page. This is the wire
 * contract for `POST /session/:token/feedback`, shared between the API's
 * validation and the server-rendered form's radio values (docs/14 §3.6 —
 * one schema, so the form and the route cannot drift).
 *
 * Every field is optional BY DESIGN (Foundation §9: skippable forever —
 * a wholly-empty submit is a valid submit). The enums are the exact
 * values the post-Amen form's radios carry:
 *
 *  - `contentHelpful` — "Did this meet you today?" Yes / Not really
 *  - `topicMore`      — "More on this topic?" Yes, please / Mix it up
 *  - `lengthFeel`     — "The length felt…" Shorter, please / Just right / Longer is fine
 *  - `timeFeel`       — "The time of day was…" Earlier suits me / Just right / Later suits me
 *  - `note`           — "Anything else on your heart?" — same 500-char cap
 *                       as `prayerIntention` (routes/session.ts), and for
 *                       the same reason: one line, not an essay.
 *
 * `.strict()` so a JSON caller inventing fields (or a future form field
 * added without updating this contract) fails loudly instead of being
 * silently dropped — the policy-engine stories (#323/#324) read these
 * columns and must be able to trust that every stored value passed
 * through this schema.
 */
export const LengthFeelSchema = z.enum(['shorter', 'right', 'longer']);
export type LengthFeel = z.infer<typeof LengthFeelSchema>;

export const TimeFeelSchema = z.enum(['earlier', 'right', 'later']);
export type TimeFeel = z.infer<typeof TimeFeelSchema>;

export const SESSION_FEEDBACK_NOTE_MAX_LENGTH = 500;

export const SessionFeedbackBodySchema = z
  .object({
    contentHelpful: z.boolean().optional(),
    topicMore: z.boolean().optional(),
    lengthFeel: LengthFeelSchema.optional(),
    timeFeel: TimeFeelSchema.optional(),
    note: z.string().trim().min(1).max(SESSION_FEEDBACK_NOTE_MAX_LENGTH).optional(),
  })
  .strict();
export type SessionFeedbackBody = z.infer<typeof SessionFeedbackBodySchema>;

/** JSON success envelope for `POST /session/:token/feedback` (browser form POSTs get a 303 instead — routes/session.ts). */
export const SessionFeedbackResponseSchema = z.object({
  ok: z.literal(true),
});
export type SessionFeedbackResponse = z.infer<typeof SessionFeedbackResponseSchema>;
