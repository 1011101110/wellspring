# `apps/web` — the Kairos web client

Issue #195. A user can sign in with Google, connect their calendar, set every
preference, and see all of it on iOS — and vice versa.

Vite + React + TypeScript, plain CSS. No UI framework, no state library, no
router.

## Why web exists now

A browser cannot read HealthKit. While biometrics were the premise, web could
only ever be a degraded second surface. The pivot to **calendar-first**
(#196/#197) removes that: the calendar is equally available to both surfaces,
so a web user is not a lesser user — they are the PRD's "Maya" persona, and
Foundation §149 already guarantees the product works with any signal category
denied.

## The flow

```
Welcome → Sign in with Google → Calendar connect (skippable) → Preferences → Done
```

Two steps from iOS's `OnboardingStep` are deliberately absent:

- **No health step.** Browsers cannot, and since #196/#197 it is no longer the
  premise. There is nothing here to decline.
- **No invite-email step.** That screen exists on iOS to recover from Sign in
  with Apple's private relay addresses. Google sign-in returns a real address.

## State sharing is the point

There is **no local source of truth in this app** — no preferences store, no
cache, no `localStorage` of user state.

- On sign-in, one `GET /v1/preferences` populates everything. What renders is
  what the server holds, so a user who onboarded on iOS sees their real window,
  days, duration, voice, and stillness.
- Every edit goes back through `PUT /v1/preferences`, and the **response** is
  applied rather than the typed values — the server normalizes (`cadence` is
  recomputed from `activeDays`, an inverted window is repaired), and rendering
  anything else is how two clients start to disagree.
- `onboardedAt` (#225) decides whether onboarding is shown at all. A failed
  `GET` renders an error with a retry — **never** onboarding, since "we could
  not ask" must never be read as "you have not onboarded."

The only thing kept in browser storage is a one-shot `sessionStorage` flash
carrying the OAuth result across the callback page load. It is navigation
state, not connection state: whether a calendar is actually connected is always
answered by the server.

`src/lib/preferences.ts` is the whole mapping, and is the file to read first if
you are adding a preference. It has a counterpart on iOS
(`HTTPPreferencesClient.swift`); a new preference must land in both or the two
surfaces silently diverge (#195 "watch for", #193's traceability table).

## Not yet at parity with iOS

- **Tradition and translation** are rendered but disabled. They live on `users`,
  not `preferences`, and no endpoint writes them (#89) — so there is nothing to
  sync. They are shown-and-explained rather than omitted or faked, because a
  picker that evaporates on reload is exactly the "appears to work and doesn't"
  failure #193 is about. iOS lets you change them, but iOS's values are
  device-local and are reset to defaults by its own `pull()`, so neither
  surface actually syncs them today.
- **No voice preview.** iOS promises a 3-second sample; there is no TTS preview
  endpoint wired to either client.
- **No home, history, devotional detail, data ledger, or account deletion.**
  This app is onboarding + settings.
- **Time zone is push-only.** It writes `users.timezone` (#187) and is not
  echoed in the preferences response, so it is presented as detected-and-sent
  rather than as a picker that could not be pre-filled.

## Calendar connect

`GET /v1/connect/google?client=web` with the Firebase ID token and
`Accept: application/json`, then the browser is sent to the returned `authUrl`.
The API returns web clients to `${WEB_APP_BASE_URL}/connect/callback?status=…`
rather than the `kairos://` scheme iOS uses.

`client=web` and the HTTPS return path are a **separate change in
`apps/api/src/routes/connect.ts`** and are not part of this workspace. Until
that lands, this client sends the parameter, the server ignores it, and the
callback still targets the mobile scheme — so calendar connect cannot complete
end-to-end on web yet. Everything on this side of the wire is in place and the
callback route is verified against both `status=success` and `status=error`.

## Firebase

The app uses the **your web app** registration, `1:<sender-id>:web:xxxxxxxxxxxxxxxxxxxxxx`,
created for #195. The iOS `appId` must not be reused here.

These identifiers are not secrets — a browser bundle publishes them by
necessity, exactly as the committed `GoogleService-Info.plist` does on iOS (see
`docs/10_CREDENTIALS_ACCESS.md`). Access is gated by Firebase Auth's
`authorizedDomains` and by the API verifying the ID token. All of them live as
defaults in `src/config.ts` **except the API key**, which must come from the
environment:

```sh
cp apps/web/.env.example apps/web/.env.local   # then fill in VITE_FIREBASE_API_KEY
```

That one exception is a CI constraint, not a security claim. A literal `AIza…`
in a tracked file matches gitleaks' default `gcp-api-key` rule, and
`secret-scan.yml` runs it on every PR with no allowlist. (The committed iOS
plist passes only by accident: the rule requires a quote, semicolon, or
whitespace after the key, and the plist has `</string>`.) Keeping the value out
of the repo neither weakens the scanner nor obfuscates a string to defeat it.

If you would rather inline it, that is a deliberate call to make in
`secret-scan.yml`'s config — not something to work around here.

Sign-in is `signInWithPopup(new GoogleAuthProvider())`. Popup rather than
redirect: this flow already spends its one full-page navigation on the calendar
OAuth handoff, and two separately-resumable navigations would be two resumption
paths to get wrong.

## Accessibility

Held to the same bar as the `session-a11y` CI gate (docs/07 §2, WCAG AA):

- Every control is a native element with a real `<label for>`; verified zero
  unlabelled inputs.
- A skip link is the first tab stop; a single never-removed `:focus-visible`
  ring (3px, verified painting).
- 44px minimum targets, including the day circles.
- **State is never signalled by color alone.** The day circles carry three
  signals — fill (a luminance inversion, so it survives grayscale and every
  form of color vision deficiency), font weight, and a ring — plus
  `aria-pressed`. This mirrors `WeekdayCircleRow.swift`. Calendar connection
  state is stated in words, not a colored dot.
- The last-day deselection is refused and *announced* via a live region, not
  silently ignored.
- The accessible name of each day is the full word; the single letter is
  `aria-hidden` (spoken, "T, selected. T, not selected." is unusable).

## Commands

```sh
npm run dev        # vite dev server against staging
npm run build      # tsc --noEmit && vite build  (builds shared-contracts first)
npm run typecheck
npm test
```

`npm run lint` runs from the repo root and covers this workspace.

## Deploy

**Not yet deployed.** Build first, then deploy from the **repo root** (where
`firebase.json` and `.firebaserc` live):

```sh
VITE_FIREBASE_API_KEY=<the your web app api key> npm run build --workspace=apps/web
firebase deploy --only hosting --project <your-project>
```

(Or put the key in `apps/web/.env.local` and drop the inline prefix.) The build
throws a named error if the key is missing, so a keyless bundle cannot ship
silently.

`firebase.json` points hosting at `apps/web/dist` and rewrites `**` to
`/index.html` — the SPA rewrite is required, or `/connect/callback` 404s and
the OAuth return path breaks.

Firebase Auth requires the serving domain to be in `authorizedDomains`;
`<your-project>.firebaseapp.com` and `.web.app` are already there.

After deploying, the API needs `WEB_APP_BASE_URL` set to the deployed origin
for the callback to return here.

### Unverified without a deploy

Everything below needs a real deployed origin and a real user, and none of it
has been exercised:

- Google sign-in end to end (`signInWithPopup` against a real
  `authorizedDomains` entry).
- Any authenticated `/v1` call — the `GET`/`PUT` round trip is covered by unit
  tests against the shared schema, but has never hit the live API.
- Calendar connect, which additionally blocks on the `connect.ts` change above.
- That preferences set on web appear on iOS and vice versa (#195's actual
  acceptance criterion), which needs both clients and one account.
