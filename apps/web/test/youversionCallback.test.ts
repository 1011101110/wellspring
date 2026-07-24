import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  YOUVERSION_CALLBACK_PARAM,
  consumeYouVersionCallbackFromUrl,
  parseYouVersionCallback,
  peekYouVersionResult,
  stashYouVersionResult,
  takeYouVersionResult,
  type YouVersionCallbackResult,
} from '../src/lib/youversionCallback';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe('parseYouVersionCallback', () => {
  it('reads success', () => {
    expect(parseYouVersionCallback('?youversion=success')).toEqual({ status: 'success' });
    expect(parseYouVersionCallback('youversion=success')).toEqual({ status: 'success' });
  });

  it('reads success alongside other params the redirect may add', () => {
    expect(parseYouVersionCallback('?youversion=success&foo=bar')).toEqual({ status: 'success' });
  });

  it('gives the recognized "denied" reason real copy', () => {
    const result = parseYouVersionCallback('?youversion=error&reason=denied');
    expect(result?.status).toBe('error');
    expect(result).toHaveProperty(
      'message',
      "You didn't finish connecting your YouVersion account.",
    );
  });

  it('does not echo an unrecognized reason back into the page', () => {
    const result = parseYouVersionCallback('?youversion=error&reason=<script>alert(1)</script>');
    expect(result?.status).toBe('error');
    if (result?.status !== 'error') throw new Error('unreachable');
    expect(result.message).not.toContain('script');
  });

  it('returns null — not error — when there is no youversion param at all', () => {
    // An ordinary Settings visit, a bookmark, a refresh. Calling that "your
    // account failed to connect" would be a claim the user cannot check.
    expect(parseYouVersionCallback('')).toBeNull();
    expect(parseYouVersionCallback('?')).toBeNull();
    expect(parseYouVersionCallback('?foo=bar')).toBeNull();
    // The Google callback key must not be mistaken for ours.
    expect(parseYouVersionCallback('?status=success')).toBeNull();
  });

  it('returns null for an unrecognized youversion value rather than inventing an outcome', () => {
    expect(parseYouVersionCallback('?youversion=weird')).toBeNull();
    expect(parseYouVersionCallback('?youversion=')).toBeNull();
  });

  it('never reports success for anything but an explicit success', () => {
    for (const search of ['', '?youversion=error', '?youversion=succeeded', '?youversion=']) {
      expect(parseYouVersionCallback(search)?.status).not.toBe('success');
    }
  });
});

describe('the one-shot flash', () => {
  it('round-trips a result and clears it, so a reload cannot replay the banner', () => {
    const storage = memoryStorage();
    const result: YouVersionCallbackResult = { status: 'success' };
    stashYouVersionResult(result, storage);
    expect(takeYouVersionResult(storage)).toEqual(result);
    expect(takeYouVersionResult(storage)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it('peek reads WITHOUT clearing — the routing read must be idempotent', () => {
    const storage = memoryStorage();
    stashYouVersionResult({ status: 'success' }, storage);
    // Two peeks (a StrictMode double-load) both see the flash; nothing is
    // consumed until the component takes it.
    expect(peekYouVersionResult(storage)).toEqual({ status: 'success' });
    expect(peekYouVersionResult(storage)).toEqual({ status: 'success' });
    expect(storage.size()).toBe(1);
    // The clearing read still works afterwards.
    expect(takeYouVersionResult(storage)).toEqual({ status: 'success' });
    expect(peekYouVersionResult(storage)).toBeNull();
  });

  it('returns null when nothing was stashed', () => {
    expect(takeYouVersionResult(memoryStorage())).toBeNull();
    expect(peekYouVersionResult(memoryStorage())).toBeNull();
  });

  it('treats a corrupt value as no flash rather than throwing on page load', () => {
    const storage = memoryStorage();
    storage.setItem('kairos.youversionCallback', '{not json');
    expect(takeYouVersionResult(storage)).toBeNull();
  });

  it('rejects a stored value that is not a result shape', () => {
    const storage = memoryStorage();
    storage.setItem('kairos.youversionCallback', JSON.stringify({ status: 'connected' }));
    expect(takeYouVersionResult(storage)).toBeNull();
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
    expect(() => stashYouVersionResult({ status: 'success' }, throwing)).not.toThrow();
    expect(takeYouVersionResult(throwing)).toBeNull();
    expect(peekYouVersionResult(throwing)).toBeNull();
  });
});

describe('consumeYouVersionCallbackFromUrl', () => {
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
    const win = fakeWindow('/settings', '?youversion=success');
    consumeYouVersionCallbackFromUrl();
    expect(win.location.pathname).toBe('/');
    expect(takeYouVersionResult(win.sessionStorage)).toEqual({ status: 'success' });
  });

  it('is idempotent: a second call cannot downgrade a stored success', () => {
    const win = fakeWindow('/settings', '?youversion=success');
    consumeYouVersionCallbackFromUrl();
    consumeYouVersionCallbackFromUrl();
    expect(peekYouVersionResult(win.sessionStorage)).toEqual({ status: 'success' });
  });

  it('does nothing when the youversion param is absent', () => {
    const win = fakeWindow('/settings', '?status=success');
    consumeYouVersionCallbackFromUrl();
    expect(win.history.replaceState).not.toHaveBeenCalled();
    expect(peekYouVersionResult(win.sessionStorage)).toBeNull();
  });

  it('still stashes a result when the callback carries an error', () => {
    const win = fakeWindow('/settings', `?${YOUVERSION_CALLBACK_PARAM}=error&reason=denied`);
    consumeYouVersionCallbackFromUrl();
    expect(win.location.pathname).toBe('/');
    expect(peekYouVersionResult(win.sessionStorage)?.status).toBe('error');
  });
});
