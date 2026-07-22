/**
 * LiveKit room name <-> session token convention (D4/#32, docs/22 §2.1).
 *
 * No room is ever explicitly created via `RoomServiceClient.createRoom` —
 * LiveKit auto-creates a room on the first participant join, and creating
 * it eagerly at devotional-generation time would trigger automatic agent
 * dispatch (docs/09 §1b: "agents can dispatch on room join — no timing
 * logic needed") hours before anyone actually opens the join link, leaving
 * a bot waiting in an empty room. Deferring room creation to real join time
 * means the room name itself must be the only thing that ties a LiveKit
 * room back to a session — hence this deterministic, reversible mapping,
 * pure and tested independently of any LiveKit SDK call.
 */
const ROOM_PREFIX = 'kairos-room-';

/** UUIDv4 shape — mirrors `UuidParamSchema` in shared-contracts without importing it here (this module has zero deps by design). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roomNameForSessionToken(sessionToken: string): string {
  return `${ROOM_PREFIX}${sessionToken}`;
}

/**
 * Reverses `roomNameForSessionToken`. Returns `undefined` for anything that
 * isn't a well-formed Wellspring room name — a LiveKit project could in
 * principle carry other rooms (future features, manual testing in the
 * LiveKit dashboard); the webhook handler must ignore those, not throw.
 */
export function sessionTokenFromRoomName(roomName: string): string | undefined {
  if (!roomName.startsWith(ROOM_PREFIX)) return undefined;
  const token = roomName.slice(ROOM_PREFIX.length);
  return UUID_RE.test(token) ? token : undefined;
}
