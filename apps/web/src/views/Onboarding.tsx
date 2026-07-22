import { useEffect, useState } from 'react';
import { getGoogleConnectUrl } from '../api/connect';
import { describeAuthError, signInWithGoogle } from '../firebase';
import { takeConnectResult, type ConnectCallbackResult } from '../lib/connectCallback';
import { PreferencesForm } from '../components/PreferencesForm';
import type { WebPreferences } from '../lib/preferences';

/**
 * The onboarding sequence, mirroring iOS's `OnboardingStep`
 * (docs/05 §2) minus the two steps a browser cannot or should not have:
 *
 *  - **No health step.** A browser cannot read HealthKit, and since
 *    #196/#197 the calendar is the premise rather than one signal among
 *    several — so a calendar-only user is a complete user, not a degraded
 *    one (#195; PRD's "Maya" persona). There is nothing here to decline.
 *  - **No invite-email step.** That screen exists on iOS to recover from
 *    Sign in with Apple's private relay addresses. Google sign-in returns
 *    a real address, so the step would be a question with a pre-filled
 *    answer and no reason to change it.
 *
 * Everything past sign-in is skippable (docs/05 §1 P4), including
 * calendar connect.
 */
export type OnboardingStep = 'welcome' | 'signIn' | 'calendarConnect' | 'preferences' | 'done';

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <section aria-labelledby="welcome-heading" className="card">
      <h1 id="welcome-heading">Wellspring</h1>
      <p className="lede">
        Wellspring finds the open moment in your workday and books a short meeting with God.
      </p>
      <p>
        It reads the shape of your calendar — when you are free, never what your meetings are called
        — and puts one quiet, unhurried session where it actually fits.
      </p>
      <button type="button" className="primary" onClick={onNext}>
        Get started
      </button>
    </section>
  );
}

export function SignInStep({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
      // No navigation here: the auth listener in App flips the whole
      // shell over once Firebase reports the user, so there is exactly
      // one place that decides what a signed-in person sees.
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="signin-heading" className="card">
      <h1 id="signin-heading">Sign in</h1>
      <p>
        Wellspring uses your Google account so your settings follow you between the web and the iOS app.
      </p>
      <button type="button" className="primary" onClick={handleSignIn} disabled={busy}>
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </button>
      <button type="button" className="quiet" onClick={onBack}>
        Back
      </button>
      <ErrorNote message={error} />
    </section>
  );
}

export function CalendarConnectStep({
  onConnected,
  onSkip,
}: {
  onConnected: () => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the two non-success outcomes are ever held here: success advances
  // the step instead of rendering a banner, so the type says so.
  const [flash, setFlash] = useState<Exclude<ConnectCallbackResult, { status: 'success' }> | null>(
    null,
  );

  // The OAuth return is a full page load, so the result arrives here as a
  // one-shot flash rather than as in-memory state (see lib/connectCallback).
  useEffect(() => {
    const result = takeConnectResult(window.sessionStorage);
    if (!result) return;
    if (result.status === 'success') {
      onConnected();
      return;
    }
    setFlash(result);
    // Empty dependency list on purpose, and `onConnected` is deliberately
    // not listed: this must run exactly once, on the load that carries
    // the flash. `takeConnectResult` clears the key as it reads, so even
    // a double-invoked effect (React 18 StrictMode in development) sees
    // `null` the second time and does nothing.
  }, []);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const url = await getGoogleConnectUrl();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not start the connection.');
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="calendar-heading" className="card">
      <h1 id="calendar-heading">This is how Wellspring works</h1>
      {flash && (
        <p className="notice notice-warn" role="status">
          {flash.message}
        </p>
      )}
      <p className="lede">Your calendar is all Wellspring needs.</p>
      <dl className="priming">
        <dt>What Wellspring reads</dt>
        <dd>The shape of your day — when you are busy and when you are free.</dd>
        <dt>What Wellspring never reads</dt>
        <dd>Meeting titles, attendees, and notes. None of it is stored.</dd>
        <dt>What Wellspring adds</dt>
        <dd>One short event, in an opening you already had.</dd>
      </dl>
      <button type="button" className="primary" onClick={handleConnect} disabled={busy}>
        {busy ? 'Opening Google…' : 'Connect Google Calendar'}
      </button>
      <button type="button" className="quiet" onClick={onSkip}>
        Skip for now
      </button>
      <p className="hint">
        You can connect later from Settings. Until you do, Wellspring has nothing to read and will wait.
      </p>
      <ErrorNote message={error} />
    </section>
  );
}

export function PreferencesStep({
  value,
  onChange,
  timezone,
  onConfirm,
  onSkip,
  busy,
  error,
}: {
  value: WebPreferences;
  onChange: (next: WebPreferences) => void;
  timezone: string;
  onConfirm: () => void;
  onSkip: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <section aria-labelledby="prefs-heading" className="card">
      <h1 id="prefs-heading">Preferences</h1>
      <p>
        These are already filled in with your current settings — including anything you set in the
        iOS app. Change what you like, or carry on.
      </p>
      <PreferencesForm
        value={value}
        onChange={onChange}
        timezone={timezone}
        idPrefix="onboarding"
      />
      <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
        {busy ? 'Saving…' : 'Looks good'}
      </button>
      <button type="button" className="quiet" onClick={onSkip} disabled={busy}>
        Skip for now
      </button>
      <ErrorNote message={error} />
    </section>
  );
}

export function DoneStep({
  onFinish,
  busy,
  error,
  calendarConnected,
}: {
  onFinish: () => void;
  busy: boolean;
  error: string | null;
  calendarConnected: boolean;
}) {
  return (
    <section aria-labelledby="done-heading" className="card">
      <h1 id="done-heading">You&rsquo;re set</h1>
      <p className="lede">
        {calendarConnected
          ? 'Your first devotional will appear on your calendar tomorrow morning.'
          : 'Connect a calendar whenever you are ready, and your first devotional will follow.'}
      </p>
      <p>Everything here is editable any time from Settings, on the web or on your phone.</p>
      <button type="button" className="primary" onClick={onFinish} disabled={busy}>
        {busy ? 'Finishing…' : 'Finish'}
      </button>
      <ErrorNote message={error} />
    </section>
  );
}

/**
 * One error presentation for the whole flow. `role="alert"` so a failure
 * reaches a screen reader without the user having to go hunting for what
 * changed, and the message is always copy we wrote — never a raw server
 * body.
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  );
}
