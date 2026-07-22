import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_CALLBACK_PATH,
  consumeConnectCallbackFromUrl,
  parseConnectCallback,
  stashConnectResult,
  takeConnectResult,
  type ConnectCallbackResult,
} from '../src/lib/connectCallback';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe('parseConnectCallback', () => {
  it('reads success', () => {
    expect(parseConnectCallback('?status=success')).toEqual({ status: 'success' });
    expect(parseConnectCallback('status=success')).toEqual({ status: 'success' });
  });

  it('reads success alongside other params the API may add', () => {
    expect(parseConnectCallback('?status=success&provider=google')).toEqual({ status: 'success' });
  });

  it('gives a recognized error reason real copy', () => {
    const result = parseConnectCallback('?status=error&reason=access_denied');
    expect(result.status).toBe('error');
    expect(result).toHaveProperty(
      'message',
      "You didn't finish granting access to Google Calendar.",
    );
  });

  it('does not echo an unrecognized reason back into the page', () => {
    const result = parseConnectCallback('?status=error&reason=<script>alert(1)</script>');
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.message).not.toContain('script');
  });

  it('reports unknown — not error — when there is no status at all', () => {
    // A bookmark, a refresh, or a callback shape that changed. Calling
    // that "your calendar failed to connect" would be a claim we cannot
    // support and the user cannot check.
    expect(parseConnectCallback('').status).toBe('unknown');
    expect(parseConnectCallback('?').status).toBe('unknown');
    expect(parseConnectCallback('?status=weird').status).toBe('unknown');
    expect(parseConnectCallback('?code=abc').status).toBe('unknown');
  });

  it('never reports success for anything but an explicit success', () => {
    for (const search of ['', '?status=error', '?status=succeeded', '?success=true', '?status=']) {
      expect(parseConnectCallback(search).status).not.toBe('success');
    }
  });
});

describe('the one-shot flash', () => {
  it('round-trips a result and clears it, so a reload cannot replay the banner', () => {
    const storage = memoryStorage();
    const result: ConnectCallbackResult = { status: 'success' };
    stashConnectResult(result, storage);
    expect(takeConnectResult(storage)).toEqual(result);
    expect(takeConnectResult(storage)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it('returns null when nothing was stashed', () => {
    expect(takeConnectResult(memoryStorage())).toBeNull();
  });

  it('treats a corrupt value as no flash rather than throwing on page load', () => {
    const storage = memoryStorage();
    storage.setItem('kairos.connectCallback', '{not json');
    expect(takeConnectResult(storage)).toBeNull();
  });

  it('rejects a stored value that is not a result shape', () => {
    const storage = memoryStorage();
    storage.setItem('kairos.connectCallback', JSON.stringify({ status: 'connected' }));
    expect(takeConnectResult(storage)).toBeNull();
  });

  it('survives storage being unavailable (private browsing)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => stashConnectResult({ status: 'success' }, throwing)).not.toThrow();
    expect(takeConnectResult(throwing)).toBeNull();
  });
});

/**
 * Regression tests for two ordering bugs found by actually driving the
 * callback URL in a browser, not by reading the code — both produced a
 * user who HAD connected their calendar being told otherwise.
 */
describe('consumeConnectCallbackFromUrl', () => {
  const original = globalThis.window;
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { value: original, configurable: true });
  });

  function fakeWindow(pathname: string, search: string) {
    const store = new Map<string, string>();
    const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
      const [nextPath = '/', nextSearch = ''] = url.split('?');
      win.location.pathname = nextPath;
      win.location.search = nextSearch ? `?${nextSearch}` : '';
    });
    const win = {
      location: { pathname, search },
      history: { replaceState },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
    return win;
  }

  it('stashes the status and rewrites the URL to /', () => {
    const win = fakeWindow(CONNECT_CALLBACK_PATH, '?status=success');
    consumeConnectCallbackFromUrl();
    expect(win.location.pathname).toBe('/');
    expect(takeConnectResult(win.sessionStorage)).toEqual({ status: 'success' });
  });

  it('is idempotent: a second call cannot downgrade a stored success to unknown', () => {
    // The StrictMode bug. The first pass rewrote the URL, so a second pass
    // re-read an empty search string, parsed it as `unknown`, and
    // overwrote the `success` it had just stored.
    const win = fakeWindow(CONNECT_CALLBACK_PATH, '?status=success');
    consumeConnectCallbackFromUrl();
    consumeConnectCallbackFromUrl();
    expect(takeConnectResult(win.sessionStorage)).toEqual({ status: 'success' });
  });

  it('does nothing on any other path', () => {
    const win = fakeWindow('/', '?status=success');
    consumeConnectCallbackFromUrl();
    expect(win.history.replaceState).not.toHaveBeenCalled();
    expect(takeConnectResult(win.sessionStorage)).toBeNull();
  });

  it('still stashes a result when the callback carries an error', () => {
    const win = fakeWindow(CONNECT_CALLBACK_PATH, '?status=error&reason=access_denied');
    consumeConnectCallbackFromUrl();
    expect(win.location.pathname).toBe('/');
    expect(takeConnectResult(win.sessionStorage)?.status).toBe('error');
  });
});
