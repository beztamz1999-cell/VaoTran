import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { PostgresDatabase } from '../database/db.js';

export type AuthenticationMethod = 'SESSION' | 'DEVELOPMENT_HEADER' | 'UNAUTHENTICATED';

export interface AuthContext {
  actorUserId: string | null;
  sessionId: string | null;
  method: AuthenticationMethod;
  correlationId: string;
}

export interface ActorResolver {
  resolve(request: Request, correlationId: string): Promise<AuthContext>;
}

export interface CurrentUserProvider {
  getActorUserId(context: AuthContext): string | null;
}

/**
 * Transitional resolver for local development. Production auth can replace this resolver
 * (for example with a verified session or token resolver) without changing route handlers
 * or domain/application services.
 */
export class DevelopmentHeaderActorResolver implements ActorResolver {
  constructor(private readonly enabled = true) {}

  async resolve(request: Request, correlationId: string): Promise<AuthContext> {
    const rawActor = this.enabled ? request.header('X-Actor-User-Id')?.trim() : undefined;
    return {
      actorUserId: rawActor || null,
      sessionId: null,
      method: rawActor ? 'DEVELOPMENT_HEADER' : 'UNAUTHENTICATED',
      correlationId,
    };
  }
}

/** Resolves opaque, server-side sessions. Bearer tokens are hashed before database lookup. */
export class SessionTokenActorResolver implements ActorResolver {
  constructor(private readonly db: PostgresDatabase, private readonly allowDevActorHeader = false) {}

  async resolve(request: Request, correlationId: string): Promise<AuthContext> {
    const authorization = request.header('Authorization')?.trim();
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer) {
      const tokenHash = createHash('sha256').update(bearer).digest('hex');
      const now = new Date();
      const result = await this.db.query<{ session_id: string; user_id: string }>(
        `SELECT s.id AS session_id, s.user_id
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'ACTIVE'`,
        [tokenHash, now],
      );
      const session = result.rows[0];
      if (session) {
        await this.db.query('UPDATE auth_sessions SET last_used_at = $2 WHERE id = $1 AND revoked_at IS NULL', [session.session_id, now]);
        return { actorUserId: session.user_id, sessionId: session.session_id, method: 'SESSION', correlationId };
      }
      return { actorUserId: null, sessionId: null, method: 'UNAUTHENTICATED', correlationId };
    }

    // Never used unless an operator explicitly enables the DEV/TEST compatibility path.
    if (this.allowDevActorHeader) {
      const rawActor = request.header('X-Actor-User-Id')?.trim();
      if (rawActor) return { actorUserId: rawActor, sessionId: null, method: 'DEVELOPMENT_HEADER', correlationId };
    }
    return { actorUserId: null, sessionId: null, method: 'UNAUTHENTICATED', correlationId };
  }
}

export class ContextCurrentUserProvider implements CurrentUserProvider {
  getActorUserId(context: AuthContext): string | null {
    return context.actorUserId;
  }
}
