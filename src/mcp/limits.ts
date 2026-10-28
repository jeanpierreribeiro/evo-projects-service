import { config } from '../config/env.js';
import { getRedisClient } from '../share/attempts.js';

export interface McpRateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

const DEFAULT_RATE_LIMIT: McpRateLimitConfig = {
  windowSeconds: 60,
  maxRequests: 120, // 120 requisições por minuto por ator
};

// Fallback in-memory rate limiter se Redis estiver inacessível
const memoryWindows = new Map<string, { count: number; resetAt: number }>();
// Controle de concorrência por ator (E4.3-e)
const activeExecutions = new Map<string, number>();
const MAX_CONCURRENT_PER_ACTOR = 10;

export class McpLimitsService {
  /**
   * Valida o cabeçalho Origin contra a lista explícita de origens permitidas (E4.3-a / S4).
   * Se for cliente backend/CLI/bot direto (sem Origin), permite.
   * Se houver Origin, deve constar estritamente na lista configurada.
   */
  static validateOrigin(originHeader?: string | string[]): boolean {
    if (!originHeader) return true;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!origin || !origin.trim()) return true;

    const normalized = origin.trim().toLowerCase();

    // Se as origens configuradas contiverem '*', permite (apenas para dev)
    if (config.corsOrigins.includes('*')) return true;

    return config.corsOrigins.some((allowed) => allowed.toLowerCase() === normalized);
  }

  /**
   * Aplica rate limit por ator e credencial (E4.3-e).
   * Retorna true se permitido, false se excedido.
   */
  static async checkRateLimit(
    actorId: string,
    toolName?: string
  ): Promise<{ allowed: boolean; remaining: number }> {
    const key = `rl:mcp:${actorId}${toolName ? `:${toolName}` : ''}`;
    const redis = getRedisClient();

    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        await redis.connect().catch(() => {});
      }
      if (redis.status === 'ready') {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, DEFAULT_RATE_LIMIT.windowSeconds);
        }
        const remaining = Math.max(0, DEFAULT_RATE_LIMIT.maxRequests - count);
        return {
          allowed: count <= DEFAULT_RATE_LIMIT.maxRequests,
          remaining,
        };
      }
    } catch {
      // Falha do Redis - segue para fallback em memória
    }

    const now = Date.now();
    const entry = memoryWindows.get(key);
    if (!entry || entry.resetAt < now) {
      memoryWindows.set(key, { count: 1, resetAt: now + DEFAULT_RATE_LIMIT.windowSeconds * 1000 });
      return { allowed: true, remaining: DEFAULT_RATE_LIMIT.maxRequests - 1 };
    }

    entry.count += 1;
    const remaining = Math.max(0, DEFAULT_RATE_LIMIT.maxRequests - entry.count);
    return {
      allowed: entry.count <= DEFAULT_RATE_LIMIT.maxRequests,
      remaining,
    };
  }

  /**
   * Controle de concorrência por ator (E4.3-e)
   */
  static acquireSlot(actorId: string): boolean {
    const current = activeExecutions.get(actorId) || 0;
    if (current >= MAX_CONCURRENT_PER_ACTOR) return false;
    activeExecutions.set(actorId, current + 1);
    return true;
  }

  static releaseSlot(actorId: string): void {
    const current = activeExecutions.get(actorId) || 0;
    if (current <= 1) {
      activeExecutions.delete(actorId);
    } else {
      activeExecutions.set(actorId, current - 1);
    }
  }

  /**
   * Sanitiza objetos de payload/logs para nunca expor segredos, tokens ou PINs em claro (E4.3-e).
   */
  static sanitizeLogPayload(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const sanitized = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(sanitized)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('pin') ||
        lower.includes('password') ||
        lower.includes('authorization')
      ) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof sanitized[key] === 'object') {
        sanitized[key] = McpLimitsService.sanitizeLogPayload(sanitized[key]);
      }
    }

    return sanitized;
  }
}
