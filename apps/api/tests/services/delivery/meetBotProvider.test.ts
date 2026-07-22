import { describe, expect, it } from 'vitest';
import { MeetBotProvider } from '../../../src/services/delivery/meetBotProvider.js';

describe('MeetBotProvider', () => {
  it('has kind "meetbot"', () => {
    expect(new MeetBotProvider('http://localhost:8080').kind).toBe('meetbot');
  });

  it('returns the plain session page for both joinUrl and fallbackUrl — the real Meet link is not known until the calendar step runs', () => {
    const provider = new MeetBotProvider('http://localhost:8080');
    const result = provider.prepareDelivery({ sessionToken: 'tok-123' });
    expect(result).toEqual({
      joinUrl: 'http://localhost:8080/session/tok-123',
      fallbackUrl: 'http://localhost:8080/session/tok-123',
    });
  });

  it('strips a trailing slash from publicBaseUrl', () => {
    const provider = new MeetBotProvider('http://localhost:8080/');
    expect(provider.prepareDelivery({ sessionToken: 'tok' }).joinUrl).toBe('http://localhost:8080/session/tok');
  });
});
