import { useState } from 'react';
import { PreferencesForm } from '../components/PreferencesForm';
import { RhythmCard } from '../components/RhythmCard';
import { ErrorNote } from './Onboarding';
import type { WebPreferences } from '../lib/preferences';
import { calendarSettingsState, type ConnectionState } from '../lib/connectionState';
import type { Rhythm } from '@kairos/shared-contracts';

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
  connection,
  calendarReadingEnabled,
  onToggleCalendarReading,
  onConnectCalendar,
  onSignOut,
  email,
  rhythm,
  activeDaysCount,
  onToggleScheduleFixed,
  onChangeMinPerWeek,
}: {
  value: WebPreferences;
  onChange: (next: WebPreferences) => void;
  timezone: string;
  onSave: () => void;
  busy: boolean;
  error: string | null;
  saved: boolean;
  /** The OAuth grant, from `/v1/connections` — the same source the dashboard card reads. */
  connection: ConnectionState | null;
  /** `calendar_enabled` — whether Wellspring may read free/busy once connected. */
  calendarReadingEnabled: boolean;
  /** Persists a new `calendar_enabled` value (PUT /v1/preferences). */
  onToggleCalendarReading: (next: boolean) => void;
  onConnectCalendar: () => void;
  onSignOut: () => void;
  email: string | null;
  /**
   * The server-composed rhythm summary from the LAST `/v1/preferences`
   * response (P8 #327). `undefined` (older server) hides the card
   * entirely — #244: absent, not a placeholder.
   */
  rhythm: Rhythm | undefined;
  /** |activeDays| from the same response — the ceiling the min-per-week control stays under. */
  activeDaysCount: number;
  /** Persists `adaptiveEnabled: !next` immediately (the #299 toggle pattern: a consent-like decision, not a staged edit). */
  onToggleScheduleFixed: (next: boolean) => void;
  /** Persists a new `minPerWeek` immediately. */
  onChangeMinPerWeek: (next: number) => void;
}) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Connection (OAuth) and reading consent (`calendar_enabled`) are separate
  // facts; this reconciles them into the one honest readout the section can
  // be in (#299). See `calendarSettingsState`.
  const calendar = calendarSettingsState(connection, calendarReadingEnabled);

  return (
    <section aria-labelledby="settings-heading" className="card">
      <h1 id="settings-heading">Settings</h1>
      {email && <p className="hint">Signed in as {email}</p>}

      <fieldset className="field">
        <legend>Calendar</legend>
        {/* Connection state is stated in words, not carried by a colored
            dot — the same 1.4.1 rule the day circles follow. */}
        {calendar.kind === 'not_connected' ? (
          <>
            <p className="readout">Not connected</p>
            <p className="hint">Wellspring has nothing to read until a calendar is connected.</p>
            <button type="button" className="secondary" onClick={onConnectCalendar}>
              {calendar.action}
            </button>
          </>
        ) : (
          <>
            <p className="readout">Connected</p>
            {/*
              The switch #299 was missing. A user who connected but whose
              `calendar_enabled` is false was told, on the calendar view,
              that "turning it back on is one switch in settings" — and there
              was no switch. This is it. A real checkbox, labelled in words,
              persisted immediately through `PUT /v1/preferences`.
            */}
            <label className="row" htmlFor="settings-calendar-reading">
              <input
                id="settings-calendar-reading"
                type="checkbox"
                checked={calendar.kind === 'reading_on'}
                disabled={busy}
                onChange={(e) => onToggleCalendarReading(e.target.checked)}
              />
              <span>Read my free/busy times</span>
            </label>
            <p className="hint">
              {calendar.kind === 'reading_on'
                ? 'Wellspring is reading when you are free — never what your meetings are called — and booking devotionals in the gaps.'
                : 'Reading is turned off, so Wellspring cannot see your commitments. Your Google connection is untouched; turn this on to let it read your free/busy times again.'}
            </p>
          </>
        )}
      </fieldset>

      {/* "Your rhythm" (P8 #327). Rendered from the last server response
          and persisted immediately via its callbacks — deliberately
          OUTSIDE the staged PreferencesForm/save flow, like the calendar
          reading toggle above, so the engine's transparency card can
          never disagree with what the engine is actually doing. */}
      <RhythmCard
        rhythm={rhythm}
        activeDaysCount={activeDaysCount}
        busy={busy}
        onToggleScheduleFixed={onToggleScheduleFixed}
        onChangeMinPerWeek={onChangeMinPerWeek}
      />

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
