import { describe, it, expect } from 'vitest';
import { DevotionalOutputSchema, validateDevotionalOutput } from '../src/index.js';

function validDevotional() {
  return {
    format: 'standard' as const,
    theme: 'gratitude',
    verses: [
      {
        usfm: 'PSA.118.24',
        versionId: 3034,
        reference: 'Psalm 118:24',
        fetchedText: 'This is the day that the LORD has made; let us rejoice and be glad in it.',
        attribution: 'Berean Standard Bible (BSB), public domain.',
      },
    ],
    devotionalBody:
      'Word for word this would be five hundred to seven hundred fifty words in a real ' +
      'generation; this fixture stands in for that length for schema-validity testing only.',
    cardSummary: 'A short devotional on gratitude, drawn from Psalm 118.',
    prayer: 'Lord, thank you for this day. Amen.',
    actionStep: 'Name one specific thing you are grateful for before your next meeting.',
  };
}

describe('DevotionalOutputSchema — valid cases', () => {
  it('accepts a well-formed standard devotional', () => {
    const result = DevotionalOutputSchema.safeParse(validDevotional());
    expect(result.success).toBe(true);
  });

  it('accepts a micro devotional with no optional fields', () => {
    const micro = {
      format: 'micro',
      theme: 'rest',
      verses: [
        {
          usfm: 'MAT.11.28',
          versionId: 3034,
          reference: 'Matthew 11:28',
          fetchedText: 'Come to me, all who labor and are heavy laden, and I will give you rest.',
          attribution: 'Berean Standard Bible (BSB), public domain.',
        },
      ],
      devotionalBody: 'A short word of rest for a heavy day.',
      cardSummary: 'Rest for the weary — a 2-minute pause.',
      prayer: 'Lord, give me rest. Amen.',
    };
    expect(DevotionalOutputSchema.safeParse(micro).success).toBe(true);
  });

  it('accepts an extended devotional with journalingPrompt and actionStep', () => {
    const extended = {
      ...validDevotional(),
      format: 'extended',
      journalingPrompt: 'Where did you see grace today?',
    };
    expect(DevotionalOutputSchema.safeParse(extended).success).toBe(true);
  });

  it('accepts cardSummary right at the 300-char hard limit', () => {
    const atLimit = { ...validDevotional(), cardSummary: 'x'.repeat(300) };
    expect(DevotionalOutputSchema.safeParse(atLimit).success).toBe(true);
  });

  it('validateDevotionalOutput helper returns success:true for valid input', () => {
    expect(validateDevotionalOutput(validDevotional()).success).toBe(true);
  });

  it('accepts explicit null for journalingPrompt/actionStep, not just undefined (docs/14 §3.8 / issue #90)', () => {
    const withNulls = { ...validDevotional(), journalingPrompt: null, actionStep: null };
    expect(DevotionalOutputSchema.safeParse(withNulls).success).toBe(true);
  });
});

describe('DevotionalOutputSchema — invalid cases', () => {
  it('rejects an unknown format value', () => {
    const bad = { ...validDevotional(), format: 'long' };
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty verses array', () => {
    const bad = { ...validDevotional(), verses: [] };
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a verse missing fetchedText', () => {
    const bad = validDevotional();
    // @ts-expect-error intentionally malformed for the test
    delete bad.verses[0].fetchedText;
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects cardSummary over the 300-char hard limit', () => {
    const bad = { ...validDevotional(), cardSummary: 'x'.repeat(301) };
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing required field (prayer)', () => {
    const bad = validDevotional() as Partial<ReturnType<typeof validDevotional>>;
    delete bad.prayer;
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-integer versionId', () => {
    const bad = validDevotional();
    bad.verses[0].versionId = 3034.5;
    expect(DevotionalOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('validateDevotionalOutput helper returns success:false for invalid input', () => {
    expect(validateDevotionalOutput({}).success).toBe(false);
  });
});
