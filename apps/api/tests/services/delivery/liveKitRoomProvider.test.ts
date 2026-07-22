import { describe, expect, it } from 'vitest';
import { LiveKitRoomProvider } from '../../../src/services/delivery/liveKitRoomProvider.js';

describe('LiveKitRoomProvider', () => {
  it('joinUrl points at /room/:token, fallbackUrl points at /session/:token', () => {
    const provider = new LiveKitRoomProvider('http://localhost:8080');
    const result = provider.prepareDelivery({ sessionToken: 'abc-123' });
    expect(result.joinUrl).toBe('http://localhost:8080/room/abc-123');
    expect(result.fallbackUrl).toBe('http://localhost:8080/session/abc-123');
    expect(result.joinUrl).not.toBe(result.fallbackUrl);
  });

  it('strips a trailing slash from publicBaseUrl', () => {
    const provider = new LiveKitRoomProvider('http://localhost:8080/');
    const result = provider.prepareDelivery({ sessionToken: 'tok' });
    expect(result.joinUrl).toBe('http://localhost:8080/room/tok');
  });

  it('reports kind="livekit"', () => {
    expect(new LiveKitRoomProvider('http://x').kind).toBe('livekit');
  });

  it('makes no network calls — prepareDelivery is synchronous pure URL construction', () => {
    // Type-level assertion doubles as a regression guard: if this ever
    // becomes async (e.g. someone adds a RoomServiceClient.createRoom
    // call), this line stops compiling, which is the point — see
    // liveKitRoomNaming.ts's header for why room creation must stay lazy.
    const result: { joinUrl: string; fallbackUrl: string } = new LiveKitRoomProvider(
      'http://x',
    ).prepareDelivery({ sessionToken: 't' });
    expect(result.joinUrl).toBeDefined();
  });
});
