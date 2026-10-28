import { Actor, UserActor, AccessContext } from './auth.js';
import { RoutePolicy } from './route-inventory.js';

export * from './auth.js';
export * from './route-inventory.js';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role?: string;
  avatarUrl?: string;
};

export interface AuthenticatedFastifyRequest {
  actor?: Actor;
  user?: AuthUser;
  accessContext?: AccessContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    user?: AuthUser;
    accessContext?: AccessContext;
  }

  interface FastifyContextConfig {
    policy?: RoutePolicy;
    action?: string;
    isPublic?: boolean;
  }
}
