import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { PostgresDatabase, Transaction } from '../platform/database/db.js';
import { AuthService } from '../modules/auth/service.js';
import { SessionTokenActorResolver } from '../platform/auth/context.js';
import { createApp } from '../platform/http/app.js';
import type { IdentityService } from '../modules/identity/service.js';
import type { RoomService } from '../modules/room/service.js';
import type { ParticipationService } from '../modules/participation/service.js';
import type { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import type { SearchService } from '../modules/search/service.js';

type User = { id: string; phone: string; displayName: string };
type Credential = { userId: string; passwordHash: string };
type Session = { id: string; userId: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null };

class MemoryAuthDatabase {
  readonly users = new Map<string, User>();
  readonly credentials = new Map<string, Credential>();
  readonly sessions = new Map<string, Session>();

  async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return operation(this as unknown as Transaction);
  }

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes('SELECT EXISTS(SELECT 1 FROM auth_credentials')) {
      return { rows: [{ present: this.credentials.has(values[0] as string) } as T], rowCount: 1 };
    }
    if (text.includes('INSERT INTO users')) {
      const user = { id: values[0] as string, phone: values[1] as string, displayName: values[2] as string };
      this.users.set(user.id, user);
      return { rows: [{ id: user.id, phone: user.phone, display_name: user.displayName, avatar_url: null, birth_year: null, gender: null, home_area: null, created_at: new Date(), password_hash: '' } as T], rowCount: 1 };
    }
    if (text.includes('INSERT INTO auth_credentials')) {
      const email = values[1] as string;
      if (this.credentials.has(email)) return { rows: [], rowCount: 0 };
      this.credentials.set(email, { userId: values[0] as string, passwordHash: values[2] as string });
      return { rows: [{ user_id: values[0] } as T], rowCount: 1 };
    }
    if (text.includes("SELECT id FROM sports")) return { rows: [], rowCount: 0 };
    if (text.includes('INSERT INTO event_outbox')) return { rows: [], rowCount: 1 };
    if (text.includes('INSERT INTO auth_sessions')) {
      this.sessions.set(values[0] as string, { id: values[0] as string, userId: values[1] as string, tokenHash: values[2] as string, expiresAt: values[4] as Date, revokedAt: null });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM auth_credentials c JOIN users')) {
      const credential = this.credentials.get(values[0] as string);
      const user = credential ? this.users.get(credential.userId) : undefined;
      return { rows: credential && user ? [{ id: user.id, phone: user.phone, display_name: user.displayName, avatar_url: null, birth_year: null, gender: null, home_area: null, created_at: new Date(), password_hash: credential.passwordHash } as T] : [], rowCount: credential && user ? 1 : 0 };
    }
    if (text.includes('SELECT email_normalized FROM auth_credentials')) {
      const credential = [...this.credentials.entries()].find(([, item]) => item.userId === values[0]);
      return { rows: credential ? [{ email_normalized: credential[0] } as T] : [], rowCount: credential ? 1 : 0 };
    }
    if (text.includes('FROM auth_sessions s JOIN users')) {
      const session = [...this.sessions.values()].find((item) => item.tokenHash === values[0] && item.revokedAt === null && item.expiresAt > (values[1] as Date));
      return { rows: session ? [{ session_id: session.id, user_id: session.userId } as T] : [], rowCount: session ? 1 : 0 };
    }
    if (text.includes('UPDATE auth_sessions SET last_used_at')) return { rows: [], rowCount: 1 };
    if (text.includes('UPDATE auth_sessions SET revoked_at')) {
      const session = this.sessions.get(values[0] as string);
      if (session && !session.revokedAt) session.revokedAt = values[1] as Date;
      return { rows: [], rowCount: session ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const appFor = (db: MemoryAuthDatabase, allowDevActorHeader = false) => {
  const auth = new AuthService(db as unknown as PostgresDatabase, 30);
  const identity = {
    getMe: async (userId: string) => {
      const user = db.users.get(userId);
      if (!user) throw new Error('Unknown test user');
      return { id: user.id, phone: user.phone, displayName: user.displayName, avatarUrl: null, birthYear: null, gender: null, homeArea: null, createdAt: new Date() };
    },
    updateMe: async (userId: string, patch: { displayName?: string }) => {
      const user = db.users.get(userId)!;
      if (patch.displayName) user.displayName = patch.displayName;
      return { id: user.id, phone: user.phone, displayName: user.displayName, avatarUrl: null, birthYear: null, gender: null, homeArea: null, createdAt: new Date() };
    },
    listSportProfiles: async () => [],
  } as unknown as IdentityService;
  return createApp({
    rooms: {} as RoomService, identity, participation: {} as ParticipationService, lifecycle: {} as RoomLifecycleService, search: {} as SearchService,
    auth, actorResolver: new SessionTokenActorResolver(db as unknown as PostgresDatabase, allowDevActorHeader),
  });
};

const registration = { email: 'PLAYER@Example.com ', password: 'a-strong-password', display_name: 'Player One', phone: '+84900000001' };

describe('private-alpha authentication', () => {
  it('registers with an Argon2 hash, stores only hashed sessions, and rejects duplicate identities', async () => {
    const db = new MemoryAuthDatabase();
    const app = appFor(db);
    const first = await request(app).post('/api/v1/auth/register').send(registration);
    expect(first.status).toBe(201);
    expect(first.body.data.access_token).toEqual(expect.any(String));
    expect(db.credentials.get('player@example.com')?.passwordHash).not.toBe(registration.password);
    expect(db.credentials.get('player@example.com')?.passwordHash).toMatch(/^\$argon2/);
    expect([...db.sessions.values()][0]?.tokenHash).not.toBe(first.body.data.access_token);
    expect([...db.sessions.values()][0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const duplicate = await request(app).post('/api/v1/auth/register').send({ ...registration, email: 'player@example.com' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('authenticates bearer sessions, rejects invalid credentials, revokes logout, and ignores a spoofed header', async () => {
    const db = new MemoryAuthDatabase();
    const app = appFor(db, true);
    await request(app).post('/api/v1/auth/register').send(registration);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'player@example.com', password: registration.password });
    expect(login.status).toBe(200);
    const token = login.body.data.access_token as string;

    const wrongPassword = await request(app).post('/api/v1/auth/login').send({ email: registration.email, password: 'wrong-password' });
    const unknownUser = await request(app).post('/api/v1/auth/login').send({ email: 'unknown@example.com', password: 'wrong-password' });
    expect(wrongPassword.body.error).toEqual(unknownUser.body.error);

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`).set('X-Actor-User-Id', 'spoofed-user');
    expect(me.status).toBe(200);
    expect(me.body.data.display_name).toBe('Player One');
    const headerDisabledApp = appFor(db, false);
    expect((await request(headerDisabledApp).get('/api/v1/me').set('X-Actor-User-Id', 'spoofed-user')).status).toBe(401);

    expect((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(204);
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    // A repeated logout has no state-changing effect and is safely rejected as unauthenticated.
    expect((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/me').set('Authorization', 'Bearer invalid-token')).status).toBe(401);

    const expiringLogin = await request(app).post('/api/v1/auth/login').send({ email: registration.email, password: registration.password });
    const expiringToken = expiringLogin.body.data.access_token as string;
    const expiringSession = [...db.sessions.values()].at(-1)!;
    expiringSession.expiresAt = new Date(Date.now() - 1);
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${expiringToken}`)).status).toBe(401);
  });

  it('validates account input and refuses unsafe profile fields', async () => {
    const db = new MemoryAuthDatabase();
    const app = appFor(db);
    expect((await request(app).post('/api/v1/auth/register').send({ ...registration, email: 'not-an-email' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/register').send({ ...registration, password: 'short' })).status).toBe(400);
    const registered = await request(app).post('/api/v1/auth/register').send(registration);
    const token = registered.body.data.access_token as string;
    const unsafePatch = await request(app).patch('/api/v1/me').set('Authorization', `Bearer ${token}`).send({ reliability: 0 });
    expect(unsafePatch.status).toBe(400);
  });
});
