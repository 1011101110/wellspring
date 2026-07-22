/**
 * ResendEmailSender — real `EmailSender` (icsInvite.ts) implementation
 * against Resend's HTTP API (docs/03_API_INTEGRATION_SPEC.md §5: "emailed
 * via Resend (primary) ... as a text/calendar; method=REQUEST MIME part").
 *
 * CREDENTIAL REALITY (as of this pass): `RESEND_API_KEY` is not yet
 * obtained (empty in .env) — this class is written correctly against
 * Resend's documented API shape and unit-tested with a fake `fetch`, but
 * has NOT been live-tested against the real Resend API. `ConsoleEmailSender`
 * remains the default `EmailSender` wherever no key is configured
 * (`buildEmailSenderFromEnv` below).
 *
 * Resend API shape (https://resend.com/docs/api-reference/emails/send-email):
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer ${RESEND_API_KEY}
 *   Content-Type: application/json
 *   Body: { from, to, subject, text, attachments: [{ filename, content (base64), content_type }] }
 *
 * The .ics calendar part is attached as a base64-encoded attachment with
 * `content_type: 'text/calendar; method=REQUEST'` (or `method=CANCEL`) —
 * Resend does not expose a first-class "calendar invite" body field, so
 * the multipart-alternative behavior real calendar clients rely on (an
 * inline `text/calendar` part, not just an attachment) is a known
 * limitation of this transport; if that turns out to matter for client
 * compatibility (Apple Mail / Outlook autodetection of an inline invite
 * vs. an .ics attachment), it is flagged here for follow-up once the key
 * exists and real end-to-end testing is possible.
 */
import { ConsoleEmailSender, type EmailSender, type IcsEmailMessage } from './icsInvite.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 15_000; // API spec §9: "Email (.ics): 15s".

export class ResendEmailSenderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResendEmailSenderError';
  }
}

/** Minimal fetch-like contract so tests can inject a fake without touching the network — same convention as glooTokenManager.ts's FetchLike. */
export type ResendFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ResendEmailSenderOptions {
  apiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: ResendFetchLike;
  apiUrl?: string;
}

interface ResendAttachment {
  filename: string;
  content: string; // base64
  content_type: string;
}

interface ResendSendEmailBody {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: ResendAttachment[];
}

/** MIME content-type parameter per RFC 5546 — matches IcsMethod ('REQUEST' | 'CANCEL'). */
function icsContentType(method: IcsEmailMessage['method']): string {
  return `text/calendar; method=${method}`;
}

function formatAddress(name: string | undefined, email: string): string {
  return name ? `${name} <${email}>` : email;
}

export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string;
  private readonly fetchImpl: ResendFetchLike;
  private readonly apiUrl: string;

  constructor(options: ResendEmailSenderOptions) {
    if (!options.apiKey) {
      throw new Error('ResendEmailSender requires a non-empty apiKey');
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ResendFetchLike);
    this.apiUrl = options.apiUrl ?? RESEND_API_URL;
  }

  async send(message: IcsEmailMessage): Promise<void> {
    const body: ResendSendEmailBody = {
      from: formatAddress(message.from.name, message.from.email),
      to: message.to.map((recipient) => formatAddress(recipient.name, recipient.email)),
      subject: message.subject,
      text: message.bodyText,
      attachments: [
        {
          filename: message.method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
          content: Buffer.from(message.ics, 'utf-8').toString('base64'),
          content_type: icsContentType(message.method),
        },
      ],
    };

    let response: Awaited<ReturnType<ResendFetchLike>>;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ResendEmailSenderError(
        `Resend request failed (network/transport): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      let detail: string;
      try {
        detail = JSON.stringify(await response.json());
      } catch {
        detail = await response.text().catch(() => '<unreadable body>');
      }
      throw new ResendEmailSenderError(`Resend API returned HTTP ${response.status}: ${detail}`);
    }
  }
}

/**
 * Env-driven EmailSender selection: `ResendEmailSender` when
 * `RESEND_API_KEY` is set and non-empty, `ConsoleEmailSender` otherwise —
 * "keep ConsoleEmailSender as the default when no key is configured" (task
 * requirement). Mirrors the shape of `buildAudioStorageFromEnv`
 * (audioStorageConfig.ts) for consistency with the rest of the codebase's
 * env-selector pattern.
 */
export function buildEmailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): {
  sender: EmailSender;
  description: string;
} {
  const apiKey = env.RESEND_API_KEY;
  if (apiKey) {
    return { sender: new ResendEmailSender({ apiKey }), description: 'ResendEmailSender (live)' };
  }
  return { sender: new ConsoleEmailSender(), description: 'ConsoleEmailSender (no RESEND_API_KEY configured)' };
}
