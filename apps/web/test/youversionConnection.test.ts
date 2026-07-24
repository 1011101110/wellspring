import { describe, expect, it } from 'vitest';
import {
  youVersionConnectedLabel,
  youVersionSettingsState,
} from '../src/lib/youversionConnection';

describe('youVersionSettingsState', () => {
  it('is "unsupported" when the server did not report a connection (#244)', () => {
    // The field is `.optional()` on the response; an older/newer server that
    // omits it must hide the card, never render a dead control.
    expect(youVersionSettingsState(undefined)).toEqual({ kind: 'unsupported' });
  });

  it('is "not_connected" when the server reports connected: false', () => {
    expect(youVersionSettingsState({ connected: false })).toEqual({ kind: 'not_connected' });
  });

  it('is "connected" with the display name when present', () => {
    expect(youVersionSettingsState({ connected: true, displayName: 'Ada Lovelace' })).toEqual({
      kind: 'connected',
      displayName: 'Ada Lovelace',
    });
  });

  it('is "connected" with a null name when the profile fetch had failed (name absent)', () => {
    // The API stores the connection even when the best-effort profile fetch
    // failed — so "connected, name unknown" is a real, expected state.
    expect(youVersionSettingsState({ connected: true })).toEqual({
      kind: 'connected',
      displayName: null,
    });
  });
});

describe('youVersionConnectedLabel', () => {
  it('names the account when we have a display name', () => {
    expect(youVersionConnectedLabel('Ada Lovelace')).toBe('Connected as Ada Lovelace');
  });

  it('falls back to a plain "Connected" — never a blank — when the name is unknown', () => {
    expect(youVersionConnectedLabel(null)).toBe('Connected');
  });
});
