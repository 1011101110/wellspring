# Wellspring

**A meeting with God, on your calendar.**

Wellspring reads the shape of a worker's day — Google Calendar, Microsoft 365, or Apple Calendar — finds the open moment, and books a short devotional meeting into it. Joining the event opens a spoken, personalized devotional: exact licensed Scripture from **YouVersion**, composed by **Gloo AI's Responses API** with tool calling, and adapted to how busy, rested, and stressed the day actually is (calendar busyness always; Apple HealthKit signals with granular opt-in).

Built for the **Gloo × YouVersion 2026 hackathon** — the theme is Scripture showing up where it normally isn't: in the margins of an ordinary calendar.

> The internal codename for this project is *kairos*, so package names (`@kairos/*`) and some service names still use it. The product is **Wellspring**.

## Repo layout

| Path | Contents |
|---|---|
| `packages/shared-contracts` | Zod schemas — `DevotionalOutput`, the band enums, the tool-call envelope, the fallback-key helper. Single source of truth for validated shapes; imported across the apps. |
| `apps/api` | Fastify backend (TypeScript), deployed to Cloud Run. Devotional engine, calendar/OAuth, TTS, delivery, retention. |
| `apps/web` | Vite + React onboarding and dashboard (TypeScript), deployed to Firebase Hosting. |
| `apps/ios` | SwiftUI client. Provide your own `GoogleService-Info.plist` from the committed `.example` template. |
| `fixtures/snapshots/` | Five canonical demo scenarios, each bundling input bands, free/busy blocks, a YouVersion tool-call envelope, and a complete `DevotionalOutput`. They back demo/fallback mode and CI, so nothing depends on live APIs. |

## Local development

```sh
npm install
npm run build      # shared-contracts, then the apps
npm test           # vitest across all workspaces
npm run lint
npm run typecheck

# run the API (Fastify, tsx watch — default PORT 8090)
npm run --workspace=apps/api dev
curl localhost:8090/status

# run the web client (Vite dev server — default port 5173)
npm run --workspace=apps/web dev
```

Copy `.env.example` to `.env` and fill in your own values (Firebase project, Gloo / YouVersion credentials, GCP resources). All real project identifiers are supplied at build/deploy time from environment or CI variables — the repo carries only placeholders.

## Stack

- **Backend:** Fastify + TypeScript on Cloud Run; Postgres (Cloud SQL); Cloud KMS for token encryption
- **Web:** Vite + React + TypeScript on Firebase Hosting
- **iOS:** SwiftUI
- **AI / content:** Gloo AI Responses API (tool calling), YouVersion licensed Scripture, Google Cloud Text-to-Speech
- **Contracts:** Zod schemas shared across the API and clients

## License

[MIT](LICENSE)
