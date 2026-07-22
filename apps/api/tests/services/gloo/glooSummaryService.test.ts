/**
 * Dedicated unit tests for `LoggingGlooSummaryService` (F8, issue #86 /
 * issue #21's "payload unit-tested; sender behind interface" acceptance
 * bullet). Prior coverage of the F8 payload existed only at the
 * integration level (session.integration.test.ts, which constructs the
 * real payload from a real session completion) — this file covers the
 * transport itself in isolation: it must record every summary handed to
 * it, in order, and never throw, since it stands in for a real HTTP
 * sender that doesn't exist yet (the real Gloo ingestion surface remains
 * unconfirmed with hackathon organizers, tracked as issue #21).
 */
import { describe, expect, it } from 'vitest';
import type { GlooEngagementSummary } from '@kairos/shared-contracts';
import { LoggingGlooSummaryService, type GlooSummaryService } from '../../../src/services/gloo/glooSummaryService.js';

function summary(overrides: Partial<GlooEngagementSummary> = {}): GlooEngagementSummary {
  return {
    date: '2026-07-04',
    bands: {
      recovery: 'low',
      sleepQuality: 'poor',
      activity: 'sedentary',
      busyness: 'heavy',
      communicationLoad: null,
    },
    format: 'short',
    theme: 'Rest for the weary',
    passage_usfm: 'MAT.11.28',
    versionId: 3034,
    completed: true,
    durationListenedSec: 291,
    ...overrides,
  };
}

describe('LoggingGlooSummaryService', () => {
  it('conforms to the GlooSummaryService interface — a real sender can be substituted with no call-site changes', () => {
    // Compile-time proof: this assignment only type-checks if the class
    // genuinely implements the interface, not just structurally resembles it.
    const service: GlooSummaryService = new LoggingGlooSummaryService();
    expect(service).toBeInstanceOf(LoggingGlooSummaryService);
  });

  it('records the exact summary object it was given', async () => {
    const service = new LoggingGlooSummaryService();
    const input = summary();

    await service.send(input);

    expect(service.sent).toHaveLength(1);
    expect(service.sent[0]).toEqual(input);
  });

  it('accumulates every call in order across multiple sends', async () => {
    const service = new LoggingGlooSummaryService();
    const first = summary({ date: '2026-07-01', theme: 'First' });
    const second = summary({ date: '2026-07-02', theme: 'Second' });

    await service.send(first);
    await service.send(second);

    expect(service.sent).toEqual([first, second]);
  });

  it('never throws — a no-op stub must not become a failure point for session completion', async () => {
    const service = new LoggingGlooSummaryService();
    await expect(service.send(summary())).resolves.toBeUndefined();
  });

  it('preserves a null durationListenedSec (not-yet-listened completion) without coercing it', async () => {
    const service = new LoggingGlooSummaryService();
    const input = summary({ durationListenedSec: null });

    await service.send(input);

    expect(service.sent[0]?.durationListenedSec).toBeNull();
  });
});
