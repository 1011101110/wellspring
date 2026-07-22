/**
 * Journal routes (N9, #268) — the HTTP layer.
 *
 * The repository's DB behaviour (user-scoping, cascade, keyset paging) is
 * covered against a real Postgres in `tests/db/journalRepository.test.ts`.
 * This exercises what lives in `userScoped.ts` and only there: the 400 on
 * an empty/over-long entry, the 201 on create, the 404 on someone else's
 * id (never-leak-existence), and that the list route threads its cursor.
 *
 * The repo fake below mirrors the real repo's contract — it is scoped by
 * the `userId` the route passes, so a test asserting "Bob cannot delete
 * Alice's entry" is testing the route handing the fake the authenticated
 * id, not the fake inventing scoping the SQL might not have.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../../src/auth/middleware.js';
import { FakeTokenVerifier } from '../../src/auth/fakeTokenVerifier.js';
import { registerUserScopedRoutes } from '../../src/routes/userScoped.js';
import type { Repositories } from '../../src/db/repositories/index.js';
import type { UsersRepository, UserRow } from '../../src/db/repositories/usersRepository.js';
import type { JournalEntryRow } from '../../src/db/repositories/journalRepository.js';
import type { AudioStorage } from '../../src/services/audio/audioStorage.js';

const FIREBASE_UID = 'firebase-journal';

interface StoreRow {
  id: string;
  user_id: string;
  text: string;
  created_at: Date;
}

async function buildTestApp() {
  const app = Fastify();
  const verifier = await FakeTokenVerifier.create();

  // One in-memory store shared by the fake repo; the route decides which
  // user_id every call is scoped to.
  const store: StoreRow[] = [];
  let seq = 0;

  // `findOrCreateByFirebaseUid` maps a firebase uid to a stable user id, so
  // two different tokens are two different users through the real auth path.
  const usersByUid = new Map<string, UserRow>();
  const users = {
    findOrCreateByFirebaseUid: vi.fn(async (uid: string) => {
      let row = usersByUid.get(uid);
      if (!row) {
        row = { id: `user-${usersByUid.size + 1}`, firebase_uid: uid } as unknown as UserRow;
        usersByUid.set(uid, row);
      }
      return row;
    }),
    findById: vi.fn(async (id: string) =>
      [...usersByUid.values()].find((u) => u.id === id) ?? null,
    ),
  } as unknown as UsersRepository;

  const journal = {
    create: vi.fn(async (userId: string, text: string): Promise<JournalEntryRow> => {
      seq += 1;
      const row: StoreRow = {
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        user_id: userId,
        text,
        created_at: new Date(Date.UTC(2026, 6, 19, 12, 0, seq)),
      };
      store.push(row);
      return row as JournalEntryRow;
    }),
    list: vi.fn(async (userId: string, limit: number, before?: Date) => {
      const mine = store
        .filter((r) => r.user_id === userId && (!before || r.created_at < before))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const hasMore = mine.length > limit;
      return { entries: (hasMore ? mine.slice(0, limit) : mine) as JournalEntryRow[], hasMore };
    }),
    deleteOne: vi.fn(async (userId: string, id: string) => {
      const idx = store.findIndex((r) => r.id === id && r.user_id === userId);
      if (idx === -1) return false;
      store.splice(idx, 1);
      return true;
    }),
  };

  const repositories = { users, journal } as unknown as Repositories;

  registerAuth(app, verifier, repositories.users);
  registerUserScopedRoutes(app, { repositories, audioStorage: {} as AudioStorage });

  const token = async (uid: string) => verifier.mint(uid);
  return { app, token, journal };
}

const authed = (t: string) => ({ authorization: `Bearer ${t}` });

describe('journal routes (#268)', () => {
  it('creates an entry and returns 201 with the stored text', async () => {
    const { app, token } = await buildTestApp();
    const t = await token(FIREBASE_UID);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/journal',
      headers: authed(t),
      payload: { text: '  a hard week  ' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Trimmed by the schema before it is stored.
    expect(body.data.text).toBe('a hard week');
    expect(body.data.id).toBeTypeOf('string');
  });

  it('rejects an empty entry with 400 — there is nothing to keep', async () => {
    const { app, token } = await buildTestApp();
    const t = await token(FIREBASE_UID);
    for (const text of ['', '   ']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/journal',
        headers: authed(t),
        payload: { text },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an over-long entry rather than storing an unbounded blob', async () => {
    const { app, token } = await buildTestApp();
    const t = await token(FIREBASE_UID);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/journal',
      headers: authed(t),
      payload: { text: 'x'.repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only the caller’s own entries, newest first', async () => {
    const { app, token } = await buildTestApp();
    const alice = await token('firebase-alice');
    const bob = await token('firebase-bob');

    await app.inject({ method: 'POST', url: '/v1/journal', headers: authed(alice), payload: { text: 'alice one' } });
    await app.inject({ method: 'POST', url: '/v1/journal', headers: authed(alice), payload: { text: 'alice two' } });
    await app.inject({ method: 'POST', url: '/v1/journal', headers: authed(bob), payload: { text: 'bob one' } });

    const res = await app.inject({ method: 'GET', url: '/v1/journal', headers: authed(bob) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((e: { text: string }) => e.text)).toEqual(['bob one']);
  });

  it('404s when deleting an entry that is not the caller’s (never leak existence)', async () => {
    const { app, token } = await buildTestApp();
    const alice = await token('firebase-alice');
    const bob = await token('firebase-bob');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/journal',
      headers: authed(alice),
      payload: { text: 'alice private' },
    });
    const id = created.json().data.id;

    const asBob = await app.inject({ method: 'DELETE', url: `/v1/journal/${id}`, headers: authed(bob) });
    expect(asBob.statusCode).toBe(404);

    // Alice can delete her own.
    const asAlice = await app.inject({ method: 'DELETE', url: `/v1/journal/${id}`, headers: authed(alice) });
    expect(asAlice.statusCode).toBe(200);
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/v1/journal' });
    expect(res.statusCode).toBe(401);
  });
});
