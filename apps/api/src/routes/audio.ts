/**
 * GET /audio/:token — streams the MP3 that LocalFileAudioStorage's
 * `getSignedUrl` mints as `${baseUrl}/audio/<token>` (issue #68, docs/14
 * §1.2). Registered in the SAME session child scope as `/session/:token`
 * (app.ts) so it shares that scope's rate-limit + CSP configuration —
 * this route serves the same capability-token-gated surface, just for
 * bytes instead of HTML.
 *
 * Local-mode only: GCS-mode `AudioStorage.getSignedUrl` returns a direct
 * `storage.googleapis.com` V4 signed URL and the browser fetches that
 * URL directly — this route is never reached in that mode. We duck-type
 * on `LocalFileAudioStorage`'s token-verification API rather than adding
 * `readForToken`/`verifyToken` to the generic `AudioStorage` interface,
 * since GCS has no equivalent local concept of "verify this bearer token
 * against my own HMAC" (its signed URLs are self-verifying at the GCS
 * edge, not by this process).
 *
 * Enumeration safety (docs/04 §5.4, mirrored from /session/:token):
 * invalid, malformed, tampered, wrong-object, and expired tokens all
 * return the IDENTICAL 404 — no header or body difference that would
 * let a caller distinguish "never existed" from "existed, now expired".
 *
 * Range support (docs/14 §1.2 "iOS Safari requires range requests for
 * <audio> seeking"): a single-range `bytes=start-end` (or `bytes=start-`)
 * request gets a 206 with `Content-Range`/`Content-Length` for exactly
 * that slice; no `Range` header (or a malformed/multi-range one, which
 * we do not support) gets the full 200 body. `Accept-Ranges: bytes` is
 * sent on both so clients know they *may* range-request.
 */
import type { FastifyInstance } from 'fastify';
import { LocalFileAudioStorage } from '../services/audio/audioStorage.js';
import type { AudioStorage } from '../services/audio/audioStorage.js';

export interface AudioRoutesDeps {
  audioStorage: AudioStorage;
}

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parses a `Range` header for the single-range forms this route supports:
 * `bytes=<start>-<end>` and `bytes=<start>-` (open-ended, meaning "to end
 * of file"). Returns `undefined` for a missing/unparseable/multi-range
 * header (caller then falls back to a full 200 response) and `'invalid'`
 * for a syntactically-plausible-but-unsatisfiable range (start beyond the
 * file's length, or start > end) so the caller can send 416.
 */
function parseRange(rangeHeader: string | undefined, totalLength: number): ParsedRange | 'invalid' | undefined {
  if (!rangeHeader) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return undefined; // Not a single numeric range we understand — serve 200.

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalLength - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalLength) {
    return 'invalid';
  }
  // Clamp end to the actual file length (a client may ask for more than exists).
  return { start, end: Math.min(end, totalLength - 1) };
}

export function registerAudioRoutes(app: FastifyInstance, deps: AudioRoutesDeps): void {
  const { audioStorage } = deps;

  app.get<{ Params: { token: string } }>('/audio/:token', async (request, reply) => {
    // GCS mode: this route has no bytes to serve (playback goes straight
    // to the storage.googleapis.com signed URL) — treat as not-found
    // rather than erroring, since a client hitting this path in that mode
    // means a stale/misconfigured URL, not a real audio object.
    if (!(audioStorage instanceof LocalFileAudioStorage)) {
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    }

    const { token } = request.params;
    const verification = audioStorage.verifyToken(token);
    if (!verification.valid) {
      // Enumeration-safe: identical 404 regardless of WHY it failed
      // (malformed, bad signature, expired, wrong object never applies
      // here since we don't pass an expectedObjectKey).
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    }

    let audio: Buffer;
    try {
      audio = await audioStorage.readForToken(token);
    } catch {
      // File missing on disk despite a validly-signed token (e.g. purged,
      // or never uploaded) — same enumeration-safe 404, not a 500.
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
    }

    const totalLength = audio.length;
    const range = parseRange(request.headers.range, totalLength);

    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', 'audio/mpeg');

    if (range === 'invalid') {
      reply.header('content-range', `bytes */${totalLength}`);
      return reply.status(416).send();
    }

    if (range === undefined) {
      reply.header('content-length', String(totalLength));
      return reply.status(200).send(audio);
    }

    const { start, end } = range;
    const chunk = audio.subarray(start, end + 1);
    reply.header('content-range', `bytes ${start}-${end}/${totalLength}`);
    reply.header('content-length', String(chunk.length));
    return reply.status(206).send(chunk);
  });
}
