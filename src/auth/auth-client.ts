import { config } from '../config/env.js';
import { AuthUser } from '../types/index.js';

interface CacheEntry {
  user: AuthUser;
  expiresAt: number;
}

const validationCache = new Map<string, CacheEntry>();

export class AuthServiceUnavailableError extends Error {
  constructor(message = 'Serviço de autenticação temporariamente indisponível') {
    super(message);
    this.name = 'AuthServiceUnavailableError';
  }
}

export class AuthClient {
  /**
   * Limpa cache expirado periodicamente
   */
  static cleanExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of validationCache.entries()) {
      if (entry.expiresAt <= now) {
        validationCache.delete(key);
      }
    }
  }

  /**
   * Invalida explicitamente cache de um token
   */
  static invalidateToken(token: string) {
    validationCache.delete(token);
  }

  /**
   * Valida token contra o serviço de Auth (evo-auth) com política de cache
   */
  static async validateToken(
    token: string,
    isSensitiveRoute = false
  ): Promise<{ valid: boolean; user?: AuthUser; error?: string }> {
    const now = Date.now();

    // Rotas não sensíveis podem aproveitar cache válido (máximo 60s)
    if (!isSensitiveRoute) {
      const cached = validationCache.get(token);
      if (cached && cached.expiresAt > now) {
        return { valid: true, user: cached.user };
      }
    }

    // Consulta em tempo real ao Auth
    const validateUrl = `${config.evoAuthUrl}/api/v1/auth/validate`;
    try {
      const response = await fetch(validateUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // Timeout de 5s
      });

      if (response.status === 200) {
        const body = (await response.json()) as any;
        const data = body?.data ?? body;
        const rawUser = data?.user ?? data;

        const id = rawUser?.id || rawUser?.sub;
        if (!id) {
          validationCache.delete(token);
          return { valid: false, error: 'Resposta do serviço de autenticação sem identificador canônico' };
        }

        const user: AuthUser = {
          id: String(id),
          email: String(rawUser.email || ''),
          name: String(rawUser.name || rawUser.email?.split('@')[0] || 'Usuário'),
          role: rawUser.role?.name || rawUser.role || 'MEMBER',
          avatarUrl: rawUser.avatar_url || rawUser.avatarUrl,
        };

        // Cache positivo limitado a config.authCacheTtlSeconds (máximo 60s)
        const ttlMs = config.authCacheTtlSeconds * 1000;
        validationCache.set(token, {
          user,
          expiresAt: now + ttlMs,
        });

        return { valid: true, user };
      }

      // Se retornou 401 ou 403 do Auth, token foi revogado ou é inválido
      validationCache.delete(token);
      return { valid: false, error: 'Token revogado ou não autorizado pelo Auth' };
    } catch (err: any) {
      // Falha de rede / indisponibilidade do Auth
      console.warn(`[AuthClient] Falha ao contatar evo-auth em ${validateUrl}: ${err.message}`);

      // Operações sensíveis exigem consulta atual: fail-closed
      if (isSensitiveRoute) {
        throw new AuthServiceUnavailableError();
      }

      // Operações normais só usam cache se ainda estiver dentro do prazo
      const cached = validationCache.get(token);
      if (cached && cached.expiresAt > now) {
        return { valid: true, user: cached.user };
      }

      throw new AuthServiceUnavailableError();
    }
  }
}
