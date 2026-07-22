/**
 * What the "+" does with the server's answer (L2, issue #238).
 *
 * Extracted from the component because the interesting decision is a pure
 * one — *is a second same-day press an error?* — and the answer (no, it is
 * a success that opens what already exists) is the requirement most likely
 * to be quietly regressed into an error toast by someone tidying up error
 * handling later. A pure function with a test is the durable form of that
 * decision.
 */
import type { GenerateNowResponse } from '@kairos/shared-contracts';

export interface GenerateOutcome {
  devotionalId: string;
  /** True when the server returned today's existing devotional. */
  existing: boolean;
  /**
   * Copy to show on the opened devotional, or `null` when there is
   * nothing to explain. Never an error message: both branches of this
   * function describe a request that succeeded.
   */
  note: string | null;
}

/**
 * The already-existed branch gets copy that is true about what happened:
 * nothing was regenerated, nothing was billed, and the thing being opened
 * is the devotional the user already had. It deliberately does not
 * apologise or imply the press failed — the user asked for today's
 * devotional and is getting today's devotional.
 */
export const ALREADY_EXISTED_NOTE =
  'You already had a devotional for today, so Wellspring opened it rather than making another.';

export function describeGenerateOutcome(response: GenerateNowResponse): GenerateOutcome {
  return {
    devotionalId: response.devotionalId,
    existing: response.alreadyExisted,
    note: response.alreadyExisted ? ALREADY_EXISTED_NOTE : null,
  };
}
