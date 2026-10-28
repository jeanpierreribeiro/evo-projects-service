import { config } from '../config/env.js';

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  confirmed: boolean;
}

export interface DirectorySearchResult {
  data: DirectoryUser[];
  page: number;
  perPage: number;
  total: number;
}

export class DirectoryService {
  /**
   * Busca paginada de usuários elegíveis consumindo o diretório seguro do Auth (E1.6-a).
   * O backend resolve ID, nome, e-mail e elegibilidade, sem confiar nos dados do navegador.
   */
  static async searchUsers(
    token: string,
    query: string,
    page = 1,
    perPage = 20
  ): Promise<DirectorySearchResult> {
    const url = new URL('/api/v1/users', config.evoAuthUrl);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return { data: [], page, perPage, total: 0 };
      }

      const json = await response.json() as any;
      const rawUsers = json.data || [];
      const total = json.pagination?.total_count || rawUsers.length;

      const data: DirectoryUser[] = rawUsers.map((u: any) => ({
        id: String(u.id),
        name: u.name || u.email,
        email: u.email,
        avatarUrl: u.avatar_url || null,
        confirmed: Boolean(u.confirmed),
      }));

      return { data, page, perPage, total };
    } catch (err) {
      return { data: [], page, perPage, total: 0 };
    }
  }

  /**
   * Resolve e valida um usuário no Auth, garantindo que exista e seja elegível.
   */
  static async resolveUser(token: string, userId: string): Promise<DirectoryUser | null> {
    const search = await this.searchUsers(token, userId, 1, 10);
    const found = search.data.find((u) => u.id === userId || u.email.toLowerCase() === userId.toLowerCase());
    return found || null;
  }
}
