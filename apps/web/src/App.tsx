import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, signOutOfKairos } from './firebase';
import { getPreferences, putPreferences } from './api/preferences';
import { getGoogleConnectUrl } from './api/connect';
import { getConnections } from './api/dashboard';
import { deriveConnectionState, type ConnectionState } from './lib/connectionState';
import {
  DEFAULT_PREFERENCES,
  detectTimezone,
  fromServer,
  toUpdateRequest,
  type WebPreferences,
} from './lib/preferences';
import {
  CalendarConnectStep,
  DoneStep,
  ErrorNote,
  PreferencesStep,
  SignInStep,
  WelcomeStep,
  type OnboardingStep,
} from './views/Onboarding';
import { SettingsView } from './views/Settings';
import { DashboardView } from './views/Dashboard';
import { DevotionalDetailView } from './views/DevotionalDetail';
import type { PreferencesResponseData } from '@kairos/shared-contracts';

/**
 * The whole client, in one place, because the interesting decisions are
 * about *which* surface a person sees and there should be exactly one
 * answer to that.
 *
 * ## Server-authoritative, with no local mirror (#225)
 *
 * There is no preferences store in this app. On every sign-in the shell
 * does one `GET /v1/preferences`, and what comes back is what renders —
 * settings, consent, and whether onboarding has been completed
 * (`onboardedAt`). A user who onboarded on iOS lands straight in
 * Settings, showing their real window and days, because the server said
 * so.
 *
 * ## Why the web does not need iOS's completion latch
 *
 * `onboardedAt: null` does not mean "show onboarding" on iOS: the field
 * can be null for someone who onboarded on a device before #225, and iOS
 * keeps a local boolean as a cache so a failed fetch never re-onboards
 * anyone. The web has no such history and no local cache to consult — its
 * users are all post-#225 by construction — so the only thing it must get
 * right is the *failure* case, and it does that by refusing to guess: a
 * failed `GET` renders an error with a retry, never onboarding. Onboarding
 * is shown on a successful response saying `onboardedAt === null`, and on
 * nothing else.
 *
 * ## The landing surface is the dashboard (L1, #237)
 *
 * Before Epic L a signed-in, onboarded user landed on Settings, which is
 * not a home — it is the place you go to change something. `onboardedAt
 * != null` now lands on `dashboard`, and settings moves to secondary
 * navigation reachable from the dashboard header. The failure rule above
 * is unchanged and still governs: a failed `GET` renders an error with a
 * retry, never onboarding and never an empty dashboard (#245's "a failed
 * pull is not an empty state").
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string }
  | { kind: 'onboarding' }
  | { kind: 'dashboard' }
  /**
   * A devotional opened from the dashboard. `note` carries the honest
   * second-press copy from the "+" (#238) when that is how we got here.
   */
  | { kind: 'devotional'; id: string; note?: string }
  | { kind: 'settings' };

/**
 * There is no router, and no route table, because there is only one
 * screen tree. The app's single other URL — `/connect/callback` — is
 * consumed and rewritten to `/` in `main.tsx` before React renders, so by
 * the time this component mounts there is nothing left to route on. What
 * a person sees is decided by auth state and by the server's answer, not
 * by the path. (Firebase Hosting rewrites every path to `index.html`, so
 * a deep link or a stale bookmark lands here rather than 404ing.)
 */
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [prefs, setPrefs] = useState<WebPreferences>(DEFAULT_PREFERENCES);
  /** The last full `/v1/preferences` payload — see `load()` for why. */
  const [serverPrefs, setServerPrefs] = useState<PreferencesResponseData | null>(null);
  /**
   * Whether Wellspring may read free/busy — the `calendar_enabled` consent
   * flag from preferences. This is NOT the OAuth connection (that is
   * `calendarConnection`): a user can be connected with reading off, which
   * is exactly the state #299 left unrepresentable. Mirrors the server's
   * value so it never drifts.
   */
  const [calendarReadingEnabled, setCalendarReadingEnabled] = useState(false);
  /**
   * The OAuth grant itself, from `GET /v1/connections` — the same source
   * the dashboard's connection card reads, so Settings cannot disagree with
   * it (#299). `null` until the fetch lands, or if it fails; the derivation
   * that reads it treats an unknown connection as "not connected" rather
   * than guessing it is healthy.
   */
  const [calendarConnection, setCalendarConnection] = useState<ConnectionState | null>(null);
  /**
   * Set only when the user makes a real consent statement in this session
   * — connecting a calendar or explicitly skipping it. `undefined` means
   * "no opinion", which keeps an ordinary settings save from restating,
   * and thereby resurrecting, a decision made on iOS.
   */
  const [calendarConsent, setCalendarConsent] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const timezone = detectTimezone();

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setAuthResolved(true);
    });
  }, []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const data = await getPreferences();
      setPrefs(fromServer(data));
      // The raw server payload is retained alongside the form model
      // because the dashboard needs two fields the form does not edit:
      // `activeDays` (for the upcoming card's empty-state sentence) and
      // `inviteAddress` (L3). `WebPreferences` is deliberately the small
      // editable record — see lib/preferences.ts — so it is not the right
      // thing to widen.
      setServerPrefs(data);
      setCalendarReadingEnabled(data.calendarEnabled);
      // The OAuth connection is a separate read (#299). Best-effort: a
      // failure here must not take down a load that already has the
      // preferences it needs — Settings falls back to "not connected", the
      // same refusal-to-guess the rest of this shell uses. On the way back
      // from an OAuth round-trip the whole page reloads, so this re-runs and
      // the state is never stale across a connect.
      void getConnections()
        .then((payload) => setCalendarConnection(deriveConnectionState(payload)))
        .catch(() => setCalendarConnection(null));
      setPhase(data.onboardedAt === null ? { kind: 'onboarding' } : { kind: 'dashboard' });
      // A signed-in user has already done welcome and sign-in by
      // definition, so onboarding resumes at the calendar step — which is
      // also where the OAuth return needs to land.
      setStep('calendarConnect');
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not load your settings.',
      });
    }
  }, []);

  useEffect(() => {
    if (!authResolved) return;
    if (!user) {
      setPhase({ kind: 'signedOut' });
      return;
    }
    void load();
  }, [authResolved, user, load]);

  async function save(options: { onboardingCompleted?: boolean; calendarEnabled?: boolean } = {}) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // An explicit override (the reading toggle) wins over the session's
      // standing `calendarConsent`; absent, the standing value is used, and
      // `undefined` still means "no opinion" so an ordinary save cannot
      // restate a consent decision made on the other surface.
      const calendarEnabled =
        options.calendarEnabled !== undefined ? options.calendarEnabled : calendarConsent;
      const data = await putPreferences(
        toUpdateRequest(prefs, {
          timezone,
          calendarEnabled,
          onboardingCompleted: options.onboardingCompleted,
        }),
      );
      // Apply the response rather than keeping what was typed: the server
      // normalizes (cadence is recomputed from the days, an inverted
      // window is repaired), and showing anything other than what was
      // actually stored is how two clients start to disagree.
      setPrefs(fromServer(data));
      setServerPrefs(data);
      setCalendarReadingEnabled(data.calendarEnabled);
      setSaved(true);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save your settings.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  /**
   * The Settings calendar-reading toggle (#299). Persists the new
   * `calendar_enabled` immediately rather than waiting for the "Save
   * changes" button, because it is a consent decision, not a preference
   * edit — a user turning reading back on expects it to take effect, not to
   * be staged. `calendarConsent` is also set so a later ordinary save keeps
   * the same value rather than reverting it.
   */
  async function setCalendarReading(next: boolean) {
    setCalendarConsent(next);
    await save({ calendarEnabled: next });
  }

  async function startCalendarConnect() {
    setError(null);
    try {
      window.location.assign(await getGoogleConnectUrl());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not start the connection.');
    }
  }

  if (!authResolved || phase.kind === 'loading') {
    return (
      <Shell>
        <p role="status">Loading your settings…</p>
      </Shell>
    );
  }

  if (phase.kind === 'error') {
    return (
      <Shell>
        <section className="card">
          <h1>We could not reach Wellspring</h1>
          <ErrorNote message={phase.message} />
          <button type="button" className="primary" onClick={() => void load()}>
            Try again
          </button>
        </section>
      </Shell>
    );
  }

  if (phase.kind === 'signedOut') {
    return (
      <Shell>
        {step === 'signIn' ? (
          <SignInStep onBack={() => setStep('welcome')} />
        ) : (
          <WelcomeStep onNext={() => setStep('signIn')} />
        )}
      </Shell>
    );
  }

  /*
   * The dashboard needs the raw preferences payload. `serverPrefs` is set
   * on the same successful `GET` that produced this phase, so the guard is
   * a type narrowing rather than a real state — but it falls back to the
   * error surface rather than rendering a dashboard with invented
   * defaults, which is the same refusal-to-guess the load path uses.
   */
  if (phase.kind === 'dashboard' && serverPrefs) {
    return (
      <Shell>
        <DashboardView
          preferences={serverPrefs}
          browserZone={timezone}
          onOpenDevotional={(id, note) => setPhase({ kind: 'devotional', id, note })}
          onOpenSettings={() => setPhase({ kind: 'settings' })}
          onConnectCalendar={() => void startCalendarConnect()}
        />
        <ErrorNote message={error} />
      </Shell>
    );
  }

  if (phase.kind === 'devotional') {
    return (
      <Shell>
        <DevotionalDetailView
          devotionalId={phase.id}
          alreadyExistedNote={phase.note ?? null}
          onBack={() => setPhase({ kind: 'dashboard' })}
        />
      </Shell>
    );
  }

  if (phase.kind === 'settings') {
    return (
      <Shell>
        {/* Settings is now a secondary surface, so it needs a way home. */}
        <button type="button" className="quiet" onClick={() => setPhase({ kind: 'dashboard' })}>
          Back to your dashboard
        </button>
        <SettingsView
          value={prefs}
          onChange={(next) => {
            setPrefs(next);
            setSaved(false);
          }}
          timezone={timezone}
          onSave={() => void save()}
          busy={busy}
          error={error}
          saved={saved}
          connection={calendarConnection}
          calendarReadingEnabled={calendarReadingEnabled}
          onToggleCalendarReading={(next) => void setCalendarReading(next)}
          onConnectCalendar={() => void startCalendarConnect()}
          onSignOut={() => void signOutOfKairos()}
          email={user?.email ?? null}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {step === 'calendarConnect' && (
        <CalendarConnectStep
          onConnected={() => {
            setCalendarReadingEnabled(true);
            setCalendarConsent(true);
            setStep('preferences');
          }}
          onSkip={() => {
            setCalendarConsent(false);
            setStep('preferences');
          }}
        />
      )}
      {step === 'preferences' && (
        <PreferencesStep
          value={prefs}
          onChange={setPrefs}
          timezone={timezone}
          busy={busy}
          error={error}
          // Saved here as well as at Done so a user who closes the tab on
          // the last screen does not lose the settings they just chose.
          onConfirm={() => void save().then((ok) => ok && setStep('done'))}
          onSkip={() => setStep('done')}
        />
      )}
      {step === 'done' && (
        <DoneStep
          busy={busy}
          error={error}
          calendarConnected={calendarReadingEnabled}
          onFinish={() =>
            void save({ onboardingCompleted: true }).then((ok) => {
              // Only on a confirmed write. `onboardingCompleted` is the one
              // field on this route the server refuses to fail silently
              // about, so a client that advanced anyway would be claiming
              // a completion the server never recorded.
              // The dashboard, not settings (#260). #237 fixed the
              // returning-user path — `load()` above sends an onboarded
              // user to `dashboard` — and left the one run this was all
              // built for pointing at a settings form. A user finishing
              // onboarding landed on the screen they had just filled in,
              // and never saw the welcome banner, the "+", or anything
              // else from Epic L on the only visit where it was new.
              //
              // `save()` returns the server payload and sets `serverPrefs`
              // from it before this runs, so the `phase.kind === 'dashboard'
              // && serverPrefs` guard below is satisfied on this render.
              if (ok) setPhase({ kind: 'dashboard' });
            })
          }
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
