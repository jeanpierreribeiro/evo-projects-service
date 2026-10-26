import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthUser } from '../types/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function parseJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const payload = parseJwtPayload(token);

    if (payload) {
      const id = String(payload.sub || payload.id || payload.user_id || 'user-default');
      const email = String(payload.email || 'user@jpros.local');
      const name = String(payload.name || payload.user_name || payload.display_name || email.split('@')[0]);

      request.user = {
        id,
        email,
        name,
        role: payload.role?.name || payload.role || 'operator',
        avatarUrl: payload.avatar_url || payload.avatarUrl,
      };
      return;
    }
  }

  // Fallback for development if no token provided
  if (process.env.NODE_ENV !== 'production') {
    request.user = {
      id: (request.headers['x-user-id'] as string) || 'default-operator-id',
      email: (request.headers['x-user-email'] as string) || 'operador@jpros.local',
      name: (request.headers['x-user-name'] as string) || 'Operador jprOS',
      role: 'admin',
    };
    return;
  }

  return reply.status(401).send({ error: 'Token de autenticação não fornecido ou inválido' });
}
