import { describe, expect, it } from 'vitest';
import { HostedSessionProvider } from '../../../src/services/delivery/hostedSessionProvider.js';

describe('HostedSessionProvider', () => {
  it('returns identical joinUrl and fallbackUrl pointing at the session page', () => {
    const provider = new HostedSessionProvider('http://localhost:8080');
    const result = provider.prepareDelivery({ sessionToken: 'abc-123' });
    expect(result.joinUrl).toBe('http://localhost:8080/session/abc-123');
    expect(result.fallbackUrl).toBe('http://localhost:8080/session/abc-123');
    expect(result.joinUrl).toBe(result.fallbackUrl);
  });

  it('strips a trailing slash from publicBaseUrl (matches orchestrator behavior)', () => {
    const provider = new HostedSessionProvider('http://localhost:8080/');
    const result = provider.prepareDelivery({ sessionToken: 'tok' });
    expect(result.joinUrl).toBe('http://localhost:8080/session/tok');
  });

  it('reports kind="hosted"', () => {
    expect(new HostedSessionProvider('http://x').kind).toBe('hosted');
  });
});
