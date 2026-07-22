/**
 * Server-rendered HTML for the LiveKit room-join page (D4/#32, docs/22
 * §2.1/§4). Distinct from renderSessionPage.ts's zero-JS page — this page
 * necessarily runs JavaScript (the LiveKit client SDK) to connect to a
 * live room, so it gets its OWN, separately-scoped CSP in app.ts rather
 * than reusing the session scope's maximally restrictive one.
 *
 * The plain-audio session page is always linked as an explicit fallback
 * (DEC-K3 permanent fallback + accessibility surface) — this page must
 * never be the only way to hear a devotional.
 */
import { escapeAttr } from './html.js';

const LIVEKIT_CLIENT_CDN_URL =
  'https://cdn.jsdelivr.net/npm/livekit-client@2.20.0/dist/livekit-client.umd.min.js';

export interface RoomPageData {
  fallbackUrl: string;
}

function pageShell(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wellspring — Join your devotional</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: #faf8f5;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Georgia, serif;
    line-height: 1.6;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
    text-align: center;
  }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 1.5rem; }
  #room-status { font-size: 1.1rem; color: #4a4a4a; margin: 2rem 0; }
  .fallback-link { display: block; margin-top: 2.5rem; font-size: 0.95rem; color: #5a5a5a; }
  a { color: #3a3226; }
</style>
</head>
<body>
<main>
${bodyHtml}
</main>
<script src="${LIVEKIT_CLIENT_CDN_URL}"></script>
<script src="/room/assets/join.js"></script>
</body>
</html>`;
}

export function renderRoomPage(data: RoomPageData): string {
  return pageShell(`
<h1>Wellspring</h1>
<p id="room-status">Connecting…</p>
<p class="fallback-link">
  Prefer plain audio? <a href="${escapeAttr(data.fallbackUrl)}">Use the session page instead</a>.
</p>
`);
}
