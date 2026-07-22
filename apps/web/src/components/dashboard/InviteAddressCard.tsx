/**
 * The invite routing address (L3, issue #239).
 *
 * Inviting Wellspring to a meeting is the product's most distinctive move, and
 * before #239 the address existed only inside the inbound parser — a
 * working feature nobody could discover. This card is the discovery.
 *
 * ## Absent, never broken
 *
 * `inviteAddress` is optional in the preferences response: the server
 * omits it entirely when `INVITE_EMAIL_DOMAIN` is unconfigured, precisely
 * so a client can tell "no address" from "empty address". This component
 * is therefore rendered only when the field is present — the caller checks
 * — and there is no branch here that renders a placeholder address, a
 * blank code block, or a copy button with nothing behind it. #239's
 * acceptance is "card absent (not broken)".
 *
 * ## The address is not a secret
 *
 * It embeds the internal user UUID and the address *is* the capability, so
 * the copy presents it as something to share with a calendar invite — not
 * as a credential to guard. Wording it as a secret would be both untrue
 * and a reason for users not to use the feature.
 */
import { useEffect, useRef, useState } from 'react';

export function InviteAddressCard({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      // Long enough to be read at a normal pace, then gone — a permanent
      // "Copied" would still be claiming a copy that happened minutes ago.
      timer.current = setTimeout(() => setCopied(false), 6000);
    } catch {
      /*
       * The Clipboard API needs a secure context and a permission that can
       * be refused. Rather than fail silently — leaving the user believing
       * they hold an address they do not — say so and point at the
       * address, which is selectable text right there on the card.
       */
      setFailed(true);
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="invite-heading" className="card dash-card">
      <div className="dash-card-header">
        <h2 id="invite-heading">Your invite address</h2>
      </div>

      <p className="hint">
        Add this address as a guest on any calendar invite and Wellspring will bring a devotional to it.
      </p>

      {/* Selectable text, so the copy button is a convenience and never the
          only way to get the address. */}
      <p className="invite-address">
        <code>{address}</code>
      </p>

      <button type="button" className="secondary" onClick={() => void copy()}>
        Copy address
      </button>

      {/*
       * Announced, not colour-only (#239 acceptance, and the same 1.4.1
       * rule the weekday circles follow). `role="status"` puts the
       * confirmation in a live region so a screen-reader user hears that
       * the copy succeeded; the word "Copied" carries the meaning for
       * everyone else, with no reliance on a green tint.
       */}
      <p className="notice notice-ok" role="status">
        {copied ? `Copied ${address} to your clipboard.` : ''}
      </p>

      {failed && (
        <p className="notice notice-error" role="alert">
          Your browser would not let Wellspring use the clipboard. You can select the address above and
          copy it yourself.
        </p>
      )}
    </section>
  );
}
