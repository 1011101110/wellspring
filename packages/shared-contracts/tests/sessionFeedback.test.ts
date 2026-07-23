import { describe, expect, it } from 'vitest';
import {
  LengthFeelSchema,
  SESSION_FEEDBACK_NOTE_MAX_LENGTH,
  SessionFeedbackBodySchema,
  SessionFeedbackResponseSchema,
  TimeFeelSchema,
} from '../src/index.js';

/**
 * P1 (#320) contract round-trip. The enum VALUES are asserted literally
 * (not via the schema's own .options) because the server-rendered form's
 * radio values (renderSessionPage.ts) and the session_feedback table's
 * CHECK constraints carry these exact strings — renaming one here without
 * the others is the drift these strings pin down.
 */
describe('SessionFeedbackBodySchema (#320)', () => {
  it('round-trips a fully-answered submission', () => {
    const body = {
      contentHelpful: true,
      topicMore: false,
      lengthFeel: 'shorter',
      timeFeel: 'later',
      note: 'grateful for this one',
    };
    expect(SessionFeedbackBodySchema.parse(body)).toEqual(body);
  });

  it('accepts a partial submission — every question is optional', () => {
    expect(SessionFeedbackBodySchema.parse({ topicMore: true })).toEqual({ topicMore: true });
  });

  it('accepts a wholly-empty submission (a valid "just landed on thanks" submit)', () => {
    expect(SessionFeedbackBodySchema.parse({})).toEqual({});
  });

  it('pins the exact enum values the form radios and DB CHECKs carry', () => {
    expect(LengthFeelSchema.options).toEqual(['shorter', 'right', 'longer']);
    expect(TimeFeelSchema.options).toEqual(['earlier', 'right', 'later']);
  });

  it('rejects an out-of-enum value', () => {
    expect(SessionFeedbackBodySchema.safeParse({ lengthFeel: 'medium' }).success).toBe(false);
    expect(SessionFeedbackBodySchema.safeParse({ timeFeel: 'noon' }).success).toBe(false);
  });

  it('rejects a non-boolean for the yes/no questions (string "true" must be normalized by the route BEFORE parsing, never accepted raw)', () => {
    expect(SessionFeedbackBodySchema.safeParse({ contentHelpful: 'true' }).success).toBe(false);
    expect(SessionFeedbackBodySchema.safeParse({ topicMore: 1 }).success).toBe(false);
  });

  it('rejects a note over the 500-char cap and accepts one exactly at it', () => {
    expect(SESSION_FEEDBACK_NOTE_MAX_LENGTH).toBe(500);
    expect(SessionFeedbackBodySchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(SessionFeedbackBodySchema.safeParse({ note: 'x'.repeat(500) }).success).toBe(true);
  });

  it('is strict: unknown fields fail loudly instead of being silently dropped', () => {
    expect(SessionFeedbackBodySchema.safeParse({ streakCount: 5 }).success).toBe(false);
  });
});

describe('SessionFeedbackResponseSchema (#320)', () => {
  it('accepts the JSON success envelope and nothing else', () => {
    expect(SessionFeedbackResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(SessionFeedbackResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});
