import { describe, expect, it } from 'vitest';
import {
  roomNameForSessionToken,
  sessionTokenFromRoomName,
} from '../../../src/services/delivery/liveKitRoomNaming.js';

const TOKEN = '00000000-0000-4000-8000-000000000001';

describe('liveKitRoomNaming', () => {
  it('round-trips a session token through the room name', () => {
    const roomName = roomNameForSessionToken(TOKEN);
    expect(sessionTokenFromRoomName(roomName)).toBe(TOKEN);
  });

  it('is case-insensitive on the UUID (matches Postgres uuid column comparison semantics)', () => {
    const upper = TOKEN.toUpperCase();
    const roomName = roomNameForSessionToken(upper);
    expect(sessionTokenFromRoomName(roomName)).toBe(upper);
  });

  it('returns undefined for a room name with no kairos prefix — must never throw on a foreign room', () => {
    expect(sessionTokenFromRoomName('some-other-room')).toBeUndefined();
    expect(sessionTokenFromRoomName('')).toBeUndefined();
  });

  it('returns undefined when the suffix after the prefix is not UUID-shaped', () => {
    expect(sessionTokenFromRoomName('kairos-room-not-a-uuid')).toBeUndefined();
    expect(sessionTokenFromRoomName('kairos-room-')).toBeUndefined();
  });
});
