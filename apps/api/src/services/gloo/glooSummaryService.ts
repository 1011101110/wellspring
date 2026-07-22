import type { GlooEngagementSummary } from '@kairos/shared-contracts';

/**
 * Outbound transport for the F8 engagement summary (docs/03 §7). The real
 * Gloo ingestion endpoint is unconfirmed (tracked separately as issue #21),
 * so only a no-op stub exists today — mirrors the `EmailSender`/
 * `ConsoleEmailSender` shape in `services/invite/icsInvite.ts`.
 */
export interface GlooSummaryService {
  send(summary: GlooEngagementSummary): Promise<void>;
}

export class LoggingGlooSummaryService implements GlooSummaryService {
  public readonly sent: GlooEngagementSummary[] = [];

  async send(summary: GlooEngagementSummary): Promise<void> {
    this.sent.push(summary);
    console.log('[LoggingGlooSummaryService] would send F8 engagement summary', summary);
  }
}
