/**
 * P7 (#326): the feedback-steering decision function and its thin loader.
 *
 * Mutation-check doctrine (memory: anchored assertions): every threshold
 * here is tested from BOTH sides — the case that fires the rule and the
 * neighboring case that must not — so weakening 2-of-3 to 1-of-3, or the
 * 7-day theme shelf life, or the anti-rut run bound, fails a test rather
 * than silently changing behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_WINDOW_DAYS,
  FeedbackSteering,
  NO_STEERING,
  decideSteering,
  formatTimeLocal,
  parseTimeLocal,
  type SteeringInputs,
} from '../../../src/services/rhythm/feedbackSteering.js';
import type { SteeringFeedbackRow } from '../../../src/db/repositories/sessionFeedbackRepository.js';
import { asVerifiedUserId } from '../../../src/db/repositories/index.js';

const NOW = new Date('2026-07-23T12:00:00Z');
const MS_PER_DAY = 86_400_000;
const USER = asVerifiedUserId('00000000-0000-0000-0000-000000000001');

/** A feedback row `daysAgo` days before NOW; unanswered questions default to null (skipping is always allowed). */
function fb(
  daysAgo: number,
  answers: Partial<Pick<SteeringFeedbackRow, 'topic_more' | 'length_feel' | 'time_feel'>> & {
    theme?: string | null;
  } = {},
): SteeringFeedbackRow {
  return {
    created_at: new Date(NOW.getTime() - daysAgo * MS_PER_DAY),
    topic_more: answers.topic_more ?? null,
    length_feel: answers.length_feel ?? null,
    time_feel: answers.time_feel ?? null,
    devotional_theme: answers.theme ?? null,
  };
}

function inputs(overrides: Partial<SteeringInputs> = {}): SteeringInputs {
  return {
    now: NOW,
    feedback: [],
    recentThemes: [],
    durationPreference: null,
    windowStartLocal: '09:00:00',
    windowEndLocal: '17:00:00',
    preferredTimeLocal: null,
    ...overrides,
  };
}

describe('decideSteering — zero feedback (the regression pin)', () => {
  it('returns the empty decision: no theme, no nudge, no time, no reasons', () => {
    const decision = decideSteering(inputs());
    expect(decision.theme).toBeUndefined();
    expect(decision.durationNudge).toBeUndefined();
    expect(decision.preferredTimeLocal).toBeUndefined();
    expect(decision.preferredTimeChanged).toBe(false);
    expect(decision.reasons).toEqual([]);
  });
});

describe('decideSteering — theme (issue #326 §1)', () => {
  it('carries the theme of the latest topicMore=true devotional forward', () => {
    const decision = decideSteering(
      inputs({
        feedback: [fb(1, { topic_more: true, theme: 'Hope in waiting' })],
        recentThemes: ['Hope in waiting'],
      }),
    );
    expect(decision.theme).toBe('Hope in waiting');
    expect(decision.reasons).toContain('theme_topic_more');
  });

  it('7-day shelf life: 6.5 days steers, 7.5 days does not (mutation check on the boundary)', () => {
    const fresh = decideSteering(
      inputs({ feedback: [fb(6.5, { topic_more: true, theme: 'Hope' })], recentThemes: ['Hope'] }),
    );
    expect(fresh.theme).toBe('Hope');
    const stale = decideSteering(
      inputs({ feedback: [fb(7.5, { topic_more: true, theme: 'Hope' })], recentThemes: ['Hope'] }),
    );
    expect(stale.theme).toBeUndefined();
    expect(stale.reasons).toEqual([]);
  });

  it('topicMore=false ("mix it up") passes no theme and suppresses an older steer', () => {
    const decision = decideSteering(
      inputs({
        feedback: [fb(1, { topic_more: false }), fb(2, { topic_more: true, theme: 'Hope' })],
        recentThemes: ['Hope'],
      }),
    );
    expect(decision.theme).toBeUndefined();
    expect(decision.reasons).toContain('theme_suppressed_mix_it_up');
  });

  it('the newest ANSWERED topic question wins — a fresh yes overrides an older mix-it-up', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(0.5, { length_feel: 'right' }), // newest row skipped the topic question entirely
          fb(1, { topic_more: true, theme: 'Hope' }),
          fb(2, { topic_more: false }),
        ],
        recentThemes: ['Hope'],
      }),
    );
    expect(decision.theme).toBe('Hope');
  });

  it('no steer when the devotional (and so its theme) is gone', () => {
    const decision = decideSteering(
      inputs({ feedback: [fb(1, { topic_more: true, theme: null })], recentThemes: [] }),
    );
    expect(decision.theme).toBeUndefined();
  });

  it('anti-rut: steer, steer, no-steer across three consecutive topicMore=true on the same theme', () => {
    const feedback = [fb(1, { topic_more: true, theme: 'Hope' })];
    // Generation 1: the praised devotional is the only recent 'Hope'.
    const first = decideSteering(inputs({ feedback, recentThemes: ['Hope', 'Provision', 'Rest'] }));
    expect(first.theme).toBe('Hope');
    // Generation 2: original + one steered use.
    const second = decideSteering(inputs({ feedback, recentThemes: ['Hope', 'Hope', 'Provision'] }));
    expect(second.theme).toBe('Hope');
    // Generation 3: original + two steered uses — the steer is dropped.
    const third = decideSteering(inputs({ feedback, recentThemes: ['Hope', 'Hope', 'Hope'] }));
    expect(third.theme).toBeUndefined();
    expect(third.reasons).toContain('theme_dropped_anti_rut');
  });

  it('anti-rut counts only the CONSECUTIVE leading run — an interleaved other theme resets it', () => {
    const decision = decideSteering(
      inputs({
        feedback: [fb(1, { topic_more: true, theme: 'Hope' })],
        recentThemes: ['Hope', 'Provision', 'Hope'],
      }),
    );
    expect(decision.theme).toBe('Hope');
  });
});

describe('decideSteering — duration nudge (issue #326 §2)', () => {
  it('2 of the last 3 answered "shorter" → nudge shorter (stored preference is auto)', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(1, { length_feel: 'shorter' }),
          fb(2, { length_feel: 'right' }),
          fb(3, { length_feel: 'shorter' }),
        ],
      }),
    );
    expect(decision.durationNudge).toBe('shorter');
    expect(decision.reasons).toContain('duration_nudge_shorter');
  });

  it('1 of 3 does NOT nudge (mutation check: the threshold is 2)', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(1, { length_feel: 'shorter' }),
          fb(2, { length_feel: 'right' }),
          fb(3, { length_feel: 'longer' }),
        ],
      }),
    );
    expect(decision.durationNudge).toBeUndefined();
  });

  it('"longer" is symmetric', () => {
    const decision = decideSteering(
      inputs({
        feedback: [fb(1, { length_feel: 'longer' }), fb(2, { length_feel: 'longer' })],
      }),
    );
    expect(decision.durationNudge).toBe('longer');
  });

  it('only ANSWERED rows occupy the 3-row lookback — skipped questions neither dilute nor block', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(1), // skipped everything
          fb(2, { length_feel: 'shorter' }),
          fb(3), // skipped
          fb(4, { length_feel: 'shorter' }),
        ],
      }),
    );
    expect(decision.durationNudge).toBe('shorter');
  });

  it('a 4th-most-recent answer is outside the lookback (mutation check: last 3, not all)', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(1, { length_feel: 'right' }),
          fb(2, { length_feel: 'right' }),
          fb(3, { length_feel: 'shorter' }),
          fb(4, { length_feel: 'shorter' }),
        ],
      }),
    );
    expect(decision.durationNudge).toBeUndefined();
  });

  it('an explicit stored duration preference is never overridden — the signal is suppressed, not applied', () => {
    const decision = decideSteering(
      inputs({
        durationPreference: 'short',
        feedback: [fb(1, { length_feel: 'longer' }), fb(2, { length_feel: 'longer' })],
      }),
    );
    expect(decision.durationNudge).toBeUndefined();
    expect(decision.reasons).toContain('duration_suppressed_explicit_preference');
  });
});

describe('decideSteering — time-of-day bias (issue #326 §3)', () => {
  it('2 of last 3 "earlier" initializes from the window midpoint and shifts 30 min earlier', () => {
    const decision = decideSteering(
      inputs({
        feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
      }),
    );
    // Midpoint of 09:00–17:00 is 13:00; 30 min earlier is 12:30.
    expect(decision.preferredTimeLocal).toBe('12:30:00');
    expect(decision.preferredTimeChanged).toBe(true);
    expect(decision.reasons).toContain('time_shift_earlier');
  });

  it('"later" shifts a stored time 30 min later', () => {
    const decision = decideSteering(
      inputs({
        preferredTimeLocal: '10:00:00',
        feedback: [fb(1, { time_feel: 'later' }), fb(2, { time_feel: 'later' })],
      }),
    );
    expect(decision.preferredTimeLocal).toBe('10:30:00');
  });

  it('1 of 3 does not shift (mutation check)', () => {
    const decision = decideSteering(
      inputs({
        feedback: [
          fb(1, { time_feel: 'earlier' }),
          fb(2, { time_feel: 'right' }),
          fb(3, { time_feel: 'right' }),
        ],
      }),
    );
    expect(decision.preferredTimeLocal).toBeUndefined();
    expect(decision.preferredTimeChanged).toBe(false);
  });

  it('clamps at the window start — and never leaves the window after 10 consecutive "earlier" rounds', () => {
    let stored: string | null = null;
    for (let round = 0; round < 10; round++) {
      const decision = decideSteering(
        inputs({
          preferredTimeLocal: stored,
          feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
        }),
      );
      expect(decision.preferredTimeLocal).toBeDefined();
      const minutes = parseTimeLocal(decision.preferredTimeLocal!);
      expect(minutes).not.toBeNull();
      expect(minutes!).toBeGreaterThanOrEqual(parseTimeLocal('09:00:00')!);
      expect(minutes!).toBeLessThanOrEqual(parseTimeLocal('17:00:00')!);
      stored = decision.preferredTimeLocal!;
    }
    // 13:00 midpoint − 30 min × 10 rounds would be 08:00 — the window
    // start is the floor it actually stops at.
    expect(stored).toBe('09:00:00');
  });

  it('at the edge, another "earlier" majority is a no-op write (changed=false)', () => {
    const decision = decideSteering(
      inputs({
        preferredTimeLocal: '09:00:00',
        feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
      }),
    );
    expect(decision.preferredTimeLocal).toBe('09:00:00');
    expect(decision.preferredTimeChanged).toBe(false);
  });

  it('an established bias persists with no fresh majority — and is re-clamped when the user narrowed their window', () => {
    const steady = decideSteering(inputs({ preferredTimeLocal: '10:00:00' }));
    expect(steady.preferredTimeLocal).toBe('10:00:00');
    expect(steady.preferredTimeChanged).toBe(false);

    const narrowed = decideSteering(
      inputs({ preferredTimeLocal: '08:00:00', windowStartLocal: '09:00:00' }),
    );
    expect(narrowed.preferredTimeLocal).toBe('09:00:00');
    expect(narrowed.preferredTimeChanged).toBe(true);
    expect(narrowed.reasons).toContain('time_clamped_to_window');
  });

  it('stands down entirely on a malformed or inverted window', () => {
    const inverted = decideSteering(
      inputs({
        windowStartLocal: '17:00:00',
        windowEndLocal: '09:00:00',
        feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
      }),
    );
    expect(inverted.preferredTimeLocal).toBeUndefined();
    const malformed = decideSteering(
      inputs({
        windowStartLocal: 'not-a-time',
        feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
      }),
    );
    expect(malformed.preferredTimeLocal).toBeUndefined();
  });
});

describe('time helpers', () => {
  it('round-trips HH:MM:SS and accepts HH:MM', () => {
    expect(parseTimeLocal('09:30:00')).toBe(570);
    expect(parseTimeLocal('09:30')).toBe(570);
    expect(formatTimeLocal(570)).toBe('09:30:00');
    expect(parseTimeLocal('25:00')).toBeNull();
    expect(parseTimeLocal('nonsense')).toBeNull();
  });
});

describe('FeedbackSteering loader', () => {
  function makeDeps(opts: {
    prefs?: {
      duration_preference: 'micro' | 'short' | 'standard' | 'extended' | null;
      window_start_local: string;
      window_end_local: string;
      preferred_time_local: string | null;
    } | null;
    feedback?: SteeringFeedbackRow[];
    themes?: string[];
  }) {
    const listRecentForSteering = vi.fn().mockResolvedValue(opts.feedback ?? []);
    const listRecentThemes = vi.fn().mockResolvedValue(opts.themes ?? []);
    const get = vi.fn().mockResolvedValue(
      opts.prefs === null
        ? null
        : (opts.prefs ?? {
            duration_preference: null,
            window_start_local: '09:00:00',
            window_end_local: '17:00:00',
            preferred_time_local: null,
          }),
    );
    const updatePreferredTimeLocal = vi.fn().mockResolvedValue(undefined);
    const info = vi.fn();
    const steering = new FeedbackSteering({
      feedback: { listRecentForSteering },
      devotionals: { listRecentThemes },
      preferences: { get, updatePreferredTimeLocal },
      logger: { info },
    });
    return { steering, listRecentForSteering, listRecentThemes, get, updatePreferredTimeLocal, info };
  }

  it('returns the empty decision (and reads nothing else) when there is no preferences row', async () => {
    const { steering, listRecentForSteering } = makeDeps({ prefs: null });
    const decision = await steering.deriveSteering(USER, { now: NOW });
    expect(decision).toEqual(NO_STEERING);
    expect(listRecentForSteering).not.toHaveBeenCalled();
  });

  it('zero feedback and no stored bias: empty decision, themes never queried, nothing persisted', async () => {
    const { steering, listRecentThemes, updatePreferredTimeLocal } = makeDeps({});
    const decision = await steering.deriveSteering(USER, { now: NOW });
    expect(decision).toEqual(NO_STEERING);
    expect(listRecentThemes).not.toHaveBeenCalled();
    expect(updatePreferredTimeLocal).not.toHaveBeenCalled();
  });

  it('queries the trailing window and persists a shifted preferred time', async () => {
    const { steering, listRecentForSteering, updatePreferredTimeLocal, info } = makeDeps({
      feedback: [fb(1, { time_feel: 'earlier' }), fb(2, { time_feel: 'earlier' })],
    });
    const decision = await steering.deriveSteering(USER, { now: NOW });
    const since = listRecentForSteering.mock.calls[0]![1] as Date;
    expect(NOW.getTime() - since.getTime()).toBe(FEEDBACK_WINDOW_DAYS * MS_PER_DAY);
    expect(decision.preferredTimeLocal).toBe('12:30:00');
    expect(updatePreferredTimeLocal).toHaveBeenCalledWith(USER, '12:30:00');
    // Explainability: applied steering is logged with its reasons.
    expect(info).toHaveBeenCalledWith(
      'feedback steering derived',
      expect.objectContaining({ reasons: expect.arrayContaining(['time_shift_earlier']) }),
    );
  });

  it('does not persist when the effective time is unchanged', async () => {
    const { steering, updatePreferredTimeLocal } = makeDeps({
      prefs: {
        duration_preference: null,
        window_start_local: '09:00:00',
        window_end_local: '17:00:00',
        preferred_time_local: '10:00:00',
      },
      feedback: [fb(1, { length_feel: 'shorter' })],
    });
    const decision = await steering.deriveSteering(USER, { now: NOW });
    expect(decision.preferredTimeLocal).toBe('10:00:00');
    expect(updatePreferredTimeLocal).not.toHaveBeenCalled();
  });
});
