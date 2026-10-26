export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role?: string;
  avatarUrl?: string;
}

export interface AuthenticatedFastifyRequest {
  user?: AuthUser;
}
