import { describe, expect, it, vi } from 'vitest';
import { generateTeamDevotional } from '../../../src/services/team/teamDevotional.js';
import { NEUTRAL_DEFAULT_BANDS } from '../../../src/services/orchestrator/generateNowOrchestrator.js';
import { NO_SIGNALS_OBSERVED } from '../../../src/services/gloo/instructionsBuilder.js';
import type { DevotionalEngine, GenerateDevotionalParams } from '../../../src/services/devotionalEngine.js';

function fakeEngine() {
  const generate = vi.fn().mockResolvedValue({
    devotional: { format: 'short', theme: 'Rest', cardSummary: 'A shared moment.', devotionalBody: '...', verses: [] },
    source: 'gloo',
  });
  return { engine: { generate } as unknown as DevotionalEngine, generate };
}

const BASE = { tradition: 'general' as const, translation: 'BSB', preferredVersionId: 3034 };

describe('generateTeamDevotional (I4, #64)', () => {
  it('ALWAYS generates with NEUTRAL_DEFAULT_BANDS — no individual health personalization', async () => {
    const { engine, generate } = fakeEngine();
    await generateTeamDevotional(engine, BASE);

    const params = generate.mock.calls[0]![0] as GenerateDevotionalParams;
    expect(params.bands).toEqual(NEUTRAL_DEFAULT_BANDS);
    // distressSignal is false and communicationLoad null in the neutral profile —
    // nothing personal (or alarming) can leak into a shared devotional.
    expect(params.bands.distressSignal).toBe(false);
    expect(params.bands.communicationLoad).toBeNull();
  });

  it('declares those neutral bands as unobserved, so the devotional cannot narrate them (issue #196)', async () => {
    // Using NEUTRAL_DEFAULT_BANDS is only half the privacy guarantee. Without
    // provenance the model still receives `recovery: moderate` under "Today's
    // signals for this user" and will speak it back as something it noticed —
    // which for a team devotional would be a claim about a GROUP that Wellspring
    // has, by deliberate design, measured nothing about.
    const { engine, generate } = fakeEngine();
    await generateTeamDevotional(engine, BASE);

    const params = generate.mock.calls[0]![0] as GenerateDevotionalParams;
    expect(params.signalProvenance).toEqual(NO_SIGNALS_OBSERVED);
  });

  it('has no way for a caller to inject personal bands (enforced by the type — no bands param)', () => {
    // @ts-expect-error — GenerateTeamDevotionalParams deliberately has no `bands` field.
    const _rejected: Parameters<typeof generateTeamDevotional>[1] = { ...BASE, bands: { recovery: 'low' } };
    void _rejected;
  });

  it('threads the organizer theme through to the engine, and nothing else personal', async () => {
    const { engine, generate } = fakeEngine();
    await generateTeamDevotional(engine, { ...BASE, organizerTheme: 'this week: perseverance', date: '2026-07-10' });

    const params = generate.mock.calls[0]![0] as GenerateDevotionalParams;
    expect(params.theme).toBe('this week: perseverance');
    expect(params.date).toBe('2026-07-10');
    // Never carries a personal prayer intention or a per-person slot.
    expect(params.prayerIntention).toBeUndefined();
    expect(params.slotType).toBeUndefined();
  });

  it('omits the theme when the organizer provides none', async () => {
    const { engine, generate } = fakeEngine();
    await generateTeamDevotional(engine, BASE);
    expect((generate.mock.calls[0]![0] as GenerateDevotionalParams).theme).toBeUndefined();
  });

  it('returns the engine result unchanged', async () => {
    const { engine } = fakeEngine();
    const result = await generateTeamDevotional(engine, BASE);
    expect(result.source).toBe('gloo');
    expect(result.devotional.cardSummary).toBe('A shared moment.');
  });
});
