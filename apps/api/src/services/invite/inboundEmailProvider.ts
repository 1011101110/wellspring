/**
 * Fetches inbound email attachment content (Epic I, issue #61). Resend's
 * inbound webhook payload carries attachment METADATA only — "Webhooks do
 * not include the email body, headers, or attachments, only their
 * metadata. You must call the Received emails API or the Attachments
 * API to retrieve them" (confirmed from Resend's own docs, 2026-07-07,
 * not guessed). This is that follow-up fetch.
 *
 * Confirmed endpoint: `GET /emails/receiving/{email_id}/attachments` →
 * `{ id, filename, content_type, download_url, ... }[]`; the actual
 * bytes live behind `download_url` (a separate pre-signed fetch), not
 * inline in this response.
 */

const RESEND_API_BASE = 'https://api.resend.com';
const ICS_CONTENT_TYPES = ['text/calendar', 'application/ics'];

export interface InboundEmailProvider {
  /** Returns the raw .ics text for the first calendar attachment found, or null if none. */
  fetchIcsAttachment(emailId: string): Promise<string | null>;
}

interface ResendAttachment {
  id: string;
  filename: string;
  content_type: string;
  download_url: string;
}

export class HttpResendInboundEmailProvider implements InboundEmailProvider {
  constructor(private readonly apiKey: string) {}

  async fetchIcsAttachment(emailId: string): Promise<string | null> {
    const listResponse = await fetch(`${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!listResponse.ok) {
      const text = await listResponse.text().catch(() => '<unreadable>');
      throw new Error(`Resend list attachments failed: HTTP ${listResponse.status} — ${text}`);
    }

    const data = (await listResponse.json()) as { data?: ResendAttachment[] };
    const icsAttachment = (data.data ?? []).find(
      (attachment) =>
        ICS_CONTENT_TYPES.includes(attachment.content_type.toLowerCase()) ||
        attachment.filename.toLowerCase().endsWith('.ics'),
    );
    if (!icsAttachment) return null;

    const contentResponse = await fetch(icsAttachment.download_url);
    if (!contentResponse.ok) {
      throw new Error(`Resend attachment download failed: HTTP ${contentResponse.status}`);
    }
    return contentResponse.text();
  }
}
