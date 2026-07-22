import { describe, it, expect } from 'vitest';
import { DevotionalOutputSchema, fallbackKey, RecoverySchema } from '@kairos/shared-contracts';

/**
 * Confirms apps/api actually consumes packages/shared-contracts as a
 * workspace dependency (Issue #9 acceptance: "contracts imported by api"),
 * not just that the package builds standalone.
 */
describe('shared-contracts workspace wiring', () => {
  it('imports and uses band enums from @kairos/shared-contracts', () => {
    expect(RecoverySchema.safeParse('low').success).toBe(true);
  });

  it('imports and uses the fallback-key helper from @kairos/shared-contracts', () => {
    expect(fallbackKey('low', 'poor', 'heavy')).toBe('low_poor_heavy');
  });

  it('imports and uses DevotionalOutputSchema from @kairos/shared-contracts', () => {
    const result = DevotionalOutputSchema.safeParse({
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
      devotionalBody: 'A short word of rest.',
      cardSummary: 'Rest for the weary.',
      prayer: 'Lord, give me rest. Amen.',
    });
    expect(result.success).toBe(true);
  });
});
