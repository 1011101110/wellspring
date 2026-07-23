import {
  CADENCE_PRESETS,
  DURATION_CHOICES,
  LANGUAGE_CHOICES,
  STILLNESS_CHOICES,
  TRADITION_CHOICES,
  TRADITION_NOTE,
  VOICE_CHOICES,
  applyLanguageChange,
  cadenceLabel,
  translationChoicesFor,
  voiceDisplayLabel,
  type DurationChoice,
  type WebPreferences,
} from '../lib/preferences';
import { WeekdayRow } from './WeekdayRow';
import type { LanguageTag, Stillness } from '@kairos/shared-contracts';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${period}`;
}

/**
 * The single preferences surface, shared verbatim by onboarding step 4
 * and the settings view — the same decision iOS made when
 * `PreferencesCaptureView` and `PreferencesView` were given one
 * `WeekdayCircleRow` (docs/05 §3.1: "everything from onboarding screen 5,
 * editable any time"). Settings should not be a second, differently
 * shaped way to express the same preference.
 *
 * Every control is a native form element with a real `<label htmlFor>`,
 * so labels are clickable, the accessible name is the visible text, and
 * keyboard and screen-reader behavior is inherited rather than re-earned.
 * `idPrefix` namespaces the ids so both instances can coexist.
 */
export function PreferencesForm({
  value,
  onChange,
  timezone,
  idPrefix,
}: {
  value: WebPreferences;
  onChange: (next: WebPreferences) => void;
  timezone: string;
  idPrefix: string;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const set = <K extends keyof WebPreferences>(key: K, next: WebPreferences[K]) =>
    onChange({ ...value, [key]: next });

  // `cadence` is a readout over the day set, never stored beside it
  // (K2, #188). Picking a preset writes the days; "Custom" is what you
  // *see* when your days match neither preset, so selecting it is a
  // no-op rather than a day set of its own.
  const cadence = cadenceLabel(value.activeDays);

  return (
    <div className="prefs">
      <fieldset className="field">
        <legend>Workday window</legend>
        <p className="hint" id={id('window-hint')}>
          Wellspring looks for an open moment between these hours.
        </p>
        <div className="row">
          <div className="control">
            <label htmlFor={id('start')}>Starts at</label>
            <select
              id={id('start')}
              value={value.windowStartHour}
              aria-describedby={id('window-hint')}
              onChange={(e) => set('windowStartHour', Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div className="control">
            <label htmlFor={id('end')}>Ends at</label>
            <select
              id={id('end')}
              value={value.windowEndHour}
              aria-describedby={id('window-hint')}
              onChange={(e) => set('windowEndHour', Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <div className="control">
        <label htmlFor={id('cadence')}>Cadence</label>
        <select
          id={id('cadence')}
          value={cadence}
          aria-describedby={id('cadence-hint')}
          onChange={(e) => {
            const next = e.target.value;
            if (next === 'daily') set('activeDays', [0, 1, 2, 3, 4, 5, 6]);
            else if (next === 'weekdays') set('activeDays', [1, 2, 3, 4, 5]);
            // 'custom' names the days you already picked — nothing to apply.
          }}
        >
          {CADENCE_PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="hint" id={id('cadence-hint')}>
          Daily and Weekdays set your days below. Custom is what you see when your days match
          neither.
        </p>
      </div>

      <WeekdayRow
        days={value.activeDays}
        onChange={(d) => set('activeDays', d)}
        idPrefix={idPrefix}
      />

      <div className="control">
        <label htmlFor={id('duration')}>Duration</label>
        <select
          id={id('duration')}
          value={value.duration}
          aria-describedby={id('duration-hint')}
          onChange={(e) => set('duration', e.target.value as DurationChoice)}
        >
          {DURATION_CHOICES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="hint" id={id('duration-hint')}>
          Auto lets Wellspring pick a length that fits the day it finds.
        </p>
      </div>

      <div className="control">
        <label htmlFor={id('voice')}>Voice</label>
        <select id={id('voice')} value={value.voice} onChange={(e) => set('voice', e.target.value)}>
          {VOICE_CHOICES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {/* A voice chosen out of band (a real Chirp 3 HD id the catalog
              cannot name) is offered back rather than silently replaced by a
              default — opening this page must not overwrite a choice it has no
              label for. It is shown under a human label, never the raw id
              (#302); known ids are already normalized to a picker option by
              `fromServer`, so this branch is only the truly-unknown case. */}
          {!VOICE_CHOICES.some((option) => option.value === value.voice) && (
            <option value={value.voice}>{voiceDisplayLabel(value.voice)}</option>
          )}
        </select>
      </div>

      <div className="control">
        <label htmlFor={id('stillness')}>Stillness</label>
        <select
          id={id('stillness')}
          value={value.stillness}
          aria-describedby={id('stillness-hint')}
          onChange={(e) => set('stillness', e.target.value as Stillness)}
        >
          {STILLNESS_CHOICES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="hint" id={id('stillness-hint')}>
          After the verse — and again after the prayer — the voice hands off to quiet, then gently
          returns.
        </p>
      </div>

      <div className="control control-inline">
        <input
          type="checkbox"
          id={id('examen')}
          checked={value.examenEnabled}
          aria-describedby={id('examen-hint')}
          onChange={(e) => set('examenEnabled', e.target.checked)}
        />
        <label htmlFor={id('examen')}>Evening examen</label>
      </div>
      <p className="hint" id={id('examen-hint')}>
        Adds a short reflection at the end of the day: what gave life today, what drained it, and a
        moment to bring it to God.
      </p>

      <fieldset className="field">
        <legend>Language, tradition, and translation</legend>
        <div className="control">
          <label htmlFor={id('language')}>Language</label>
          {/* Native-script labels from LANGUAGE_CATALOG — a person picking
              their own language should not need English to find it. The
              *chrome* stays English (#311 decision 5): this chooses what
              the devotionals are made of, not what the app is written in,
              and the hint says so in as many words. */}
          <select
            id={id('language')}
            value={value.language}
            aria-describedby={id('language-hint')}
            onChange={(e) => onChange(applyLanguageChange(value, e.target.value as LanguageTag))}
          >
            {LANGUAGE_CHOICES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint" id={id('language-hint')}>
            Your devotionals — Scripture, reflection, and voice — will be in this language. The app
            itself stays in English.
          </p>
        </div>
        <div className="row">
          <div className="control">
            <label htmlFor={id('tradition')}>Tradition</label>
            {/* Rendered, disabled, and explained rather than omitted or
                faked. Tradition lives on `users` and nothing writes it
                (#89) — an enabled picker here would be a setting that
                appears to work and doesn't, which #193 is explicit is
                worse than an obviously missing one. Every tradition the
                shared model carries is listed (#192, #302), so whatever
                value the profile holds — anglican, orthodox — renders as
                its own label rather than an empty selection. */}
            <select
              id={id('tradition')}
              disabled
              value="general"
              aria-describedby={id('tradition-hint')}
            >
              {TRADITION_CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="control">
            <label htmlFor={id('translation')}>Translation</label>
            {/* Enabled since O5 (#317): O2 gave `translationId` a real
                write path, so the disabled hard-coded BSB option — and the
                apology note that covered it — retired with #89's premise.
                Options are only ever the chosen language's catalog, and a
                language change snaps the value to that language's default
                (`applyLanguageChange`), mirroring the server rule so a
                stale cross-language selection cannot exist here. */}
            <select
              id={id('translation')}
              value={value.translationId}
              onChange={(e) => set('translationId', Number(e.target.value))}
            >
              {translationChoicesFor(value.language).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="hint" id={id('tradition-hint')}>
          {TRADITION_NOTE}
        </p>
      </fieldset>

      <fieldset className="field">
        <legend>Time zone</legend>
        {/* Detected, sent on every save, and never echoed back by the API
            (it writes `users.timezone`, #187, which the preferences
            response does not carry). A picker here could not be
            pre-filled from the server and would rank below a
            calendar-derived zone anyway, so it is presented as what it
            is rather than as a control. */}
        <p className="readout">{timezone}</p>
        <p className="hint">
          Detected from your browser and sent with your settings, so your devotional lands at the
          right local time.
        </p>
      </fieldset>
    </div>
  );
}
