import { useState } from 'react';
import { PreferencesForm } from '../components/PreferencesForm';
import { ErrorNote } from './Onboarding';
import type { WebPreferences } from '../lib/preferences';

/**
 * Preferences after onboarding (docs/05 §3.1 F7), so parity is not an
 * onboarding-only claim: a user who onboarded on iOS opens this page and
 * sees their real stored values, and a change made here is the value iOS
 * pulls on its next foreground.
 *
 * Saving is explicit rather than save-on-change. iOS persists locally on
 * every keystroke and syncs behind it, which it can afford because the
 * local store is a real cache; here every edit is a network write, and a
 * select that fires a `PUT` per arrow-key press would put a burst of
 * conflicting writes on the wire for one user scrolling a list.
 */
export function SettingsView({
  value,
  onChange,
  timezone,
  onSave,
  busy,
  error,
  saved,
  calendarConnected,
  onConnectCalendar,
  onSignOut,
  email,
}: {
  value: WebPreferences;
  onChange: (next: WebPreferences) => void;
  timezone: string;
  onSave: () => void;
  busy: boolean;
  error: string | null;
  saved: boolean;
  calendarConnected: boolean;
  onConnectCalendar: () => void;
  onSignOut: () => void;
  email: string | null;
}) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  return (
    <section aria-labelledby="settings-heading" className="card">
      <h1 id="settings-heading">Settings</h1>
      {email && <p className="hint">Signed in as {email}</p>}

      <fieldset className="field">
        <legend>Calendar</legend>
        {/* Connection state is stated in words, not carried by a colored
            dot — the same 1.4.1 rule the day circles follow. */}
        <p className="readout">{calendarConnected ? 'Connected' : 'Not connected'}</p>
        {!calendarConnected && (
          <>
            <p className="hint">Wellspring has nothing to read until a calendar is connected.</p>
            <button type="button" className="secondary" onClick={onConnectCalendar}>
              Connect Google Calendar
            </button>
          </>
        )}
      </fieldset>

      <PreferencesForm value={value} onChange={onChange} timezone={timezone} idPrefix="settings" />

      <button type="button" className="primary" onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
      {/* Announced, not just shown: a save that only turns a word green is
          invisible to anyone not looking at that corner of the screen. */}
      <p className="notice notice-ok" role="status">
        {saved ? 'Saved. Your iOS app will pick this up next time it opens.' : ''}
      </p>
      <ErrorNote message={error} />

      <hr />
      {confirmingSignOut ? (
        <div className="row">
          <button type="button" className="secondary" onClick={onSignOut}>
            Yes, sign out
          </button>
          <button type="button" className="quiet" onClick={() => setConfirmingSignOut(false)}>
            Stay signed in
          </button>
        </div>
      ) : (
        <button type="button" className="quiet" onClick={() => setConfirmingSignOut(true)}>
          Sign out
        </button>
      )}
    </section>
  );
}
