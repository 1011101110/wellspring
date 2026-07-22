/**
 * Per-user invite routing address (Epic I, issue #61, docs/12 §1.4.1).
 *
 * Scheme: `u_<userId>@<INVITE_EMAIL_DOMAIN>` — a stable, deterministic
 * function of `userId`, not a separately stored/rotatable token. Per
 * docs/12's own recommendation ("recommend the per-user address" over
 * matching by sender email alone, which is fragile for forwarded invites
 * or delegate calendars) — this is *routing* only; docs/12 §1.4.3's
 * organizer-must-match-account-owner check is a separate, additional
 * safeguard applied after routing (see routes/inboundInvite.ts).
 *
 * ⚠️ Must-confirm (docs/00_FOUNDATION.md §11): `INVITE_EMAIL_DOMAIN` is a
 * placeholder until a real domain is registered and its DNS configured
 * for inbound mail — `kairos.app` referenced throughout the docs is NOT
 * currently a registered domain (verified via `dig`/`whois`, 2026-07-07 —
 * its nameservers point at a domain-parking service). Resend can also
 * receive mail on its own free `<id>.resend.app` subdomain without a
 * custom domain at all, which may be usable as an interim value.
 */

const LOCAL_PART_PREFIX = 'u_';

export function generateInviteRoutingAddress(userId: string, domain: string): string {
  return `${LOCAL_PART_PREFIX}${userId}@${domain}`;
}

/**
 * Parses a recipient address back into a userId, or null if it doesn't
 * match our routing scheme (e.g. an email sent to some other address on
 * the same domain, or a stray/malformed header). Case-insensitive on the
 * domain (per RFC 5321, domains are case-insensitive; the local part
 * technically isn't, but our own userIds are UUIDs, so case sensitivity
 * there is moot).
 */
export function parseInviteRoutingAddress(address: string, domain: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;

  const localPart = address.slice(0, at);
  const addressDomain = address.slice(at + 1);

  if (addressDomain.toLowerCase() !== domain.toLowerCase()) return null;
  if (!localPart.startsWith(LOCAL_PART_PREFIX)) return null;

  const userId = localPart.slice(LOCAL_PART_PREFIX.length);
  return userId.length > 0 ? userId : null;
}
