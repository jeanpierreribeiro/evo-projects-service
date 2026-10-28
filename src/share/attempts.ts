import { Redis } from 'ioredis';
import { config } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { NotificationService } from '../services/notification.service.js';

/**
 * Controle de Tentativas de PIN em Redis (E2.3-a / T08).
 * Contadores atômicos compartilhados entre réplicas por share+IP e por IP.
 * Aplica bloqueio temporário sem revogar o link de forma permanente.
 */

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 1000);
      },
    });

    redisClient.on('error', (err) => {
      // Log controlado sem vazar segredos
    });
  }
  return redisClient;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remainingAttempts: number;
  retryAfterSeconds?: number;
  reason?: 'SHARE_IP_LIMIT' | 'IP_GLOBAL_LIMIT' | 'SHARE_GLOBAL_THROTTLED';
}

export class RateLimiterService {
  // Parâmetros (E2.1-c / E2.3-a)
  private static MAX_ATTEMPTS_SHARE_IP = 5;
  private static MAX_ATTEMPTS_IP_GLOBAL = 25;
  private static MAX_ATTEMPTS_SHARE_GLOBAL = 30;
  private static WINDOW_SECONDS = 15 * 60; // 15 minutos (900 s)

  /**
   * Verifica se a requisição pode tentar validar o PIN.
   * Se o Redis estiver indisponível, falha de forma segura (503 Service Unavailable),
   * nunca permitindo tentativas ilimitadas.
   */
  static async checkRateLimit(shareTokenHash: string, ip: string): Promise<RateLimitCheckResult> {
    const redis = getRedisClient();

    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        await redis.connect().catch(() => {});
      }

      const keyShareIp = `rl:share_ip:${shareTokenHash}:${ip}`;
      const keyIpGlobal = `rl:ip_global:${ip}`;
      const keyShareGlobal = `rl:share_global:${shareTokenHash}`;

      const [attemptsShareIp, attemptsIpGlobal, attemptsShareGlobal, ttlShareIp] = await Promise.all([
        redis.get(keyShareIp),
        redis.get(keyIpGlobal),
        redis.get(keyShareGlobal),
        redis.ttl(keyShareIp),
      ]);

      const countShareIp = parseInt(attemptsShareIp || '0', 10);
      const countIpGlobal = parseInt(attemptsIpGlobal || '0', 10);
      const countShareGlobal = parseInt(attemptsShareGlobal || '0', 10);

      const effectiveTtl = ttlShareIp > 0 ? ttlShareIp : this.WINDOW_SECONDS;

      // 1. Bloqueio por IP naquele share específico (5 tentativas / 15 min)
      if (countShareIp >= this.MAX_ATTEMPTS_SHARE_IP) {
        return {
          allowed: false,
          remainingAttempts: 0,
          retryAfterSeconds: effectiveTtl,
          reason: 'SHARE_IP_LIMIT',
        };
      }

      // 2. Bloqueio global por IP (25 tentativas / 15 min)
      if (countIpGlobal >= this.MAX_ATTEMPTS_IP_GLOBAL) {
        return {
          allowed: false,
          remainingAttempts: 0,
          retryAfterSeconds: effectiveTtl,
          reason: 'IP_GLOBAL_LIMIT',
        };
      }

      // 3. Throttling agregado do share (30 tentativas por múltiplos IPs / 15 min)
      if (countShareGlobal >= this.MAX_ATTEMPTS_SHARE_GLOBAL) {
        return {
          allowed: false,
          remainingAttempts: 0,
          retryAfterSeconds: effectiveTtl,
          reason: 'SHARE_GLOBAL_THROTTLED',
        };
      }

      return {
        allowed: true,
        remainingAttempts: this.MAX_ATTEMPTS_SHARE_IP - countShareIp,
      };
    } catch (err) {
      // Se o Redis falhar, nunca libera tentativas ilimitadas (fail-closed)
      throw new AppError(
        503,
        'SERVICE_UNAVAILABLE',
        'O serviço de controle de tentativas está temporariamente indisponível. Tente novamente em instantes.'
      );
    }
  }

  /**
   * Registra uma tentativa de PIN falha.
   * Incrementa contadores atômicos com expiração.
   */
  static async recordFailedAttempt(
    shareTokenHash: string,
    ip: string,
    workspaceId?: string,
    taskId?: string
  ): Promise<{ remainingAttempts: number; retryAfterSeconds?: number }> {
    const redis = getRedisClient();

    try {
      const keyShareIp = `rl:share_ip:${shareTokenHash}:${ip}`;
      const keyIpGlobal = `rl:ip_global:${ip}`;
      const keyShareGlobal = `rl:share_global:${shareTokenHash}`;

      const pipeline = redis.pipeline();
      pipeline.incr(keyShareIp);
      pipeline.expire(keyShareIp, this.WINDOW_SECONDS);
      pipeline.incr(keyIpGlobal);
      pipeline.expire(keyIpGlobal, this.WINDOW_SECONDS);
      pipeline.incr(keyShareGlobal);
      pipeline.expire(keyShareGlobal, this.WINDOW_SECONDS);

      const results = await pipeline.exec();
      const countShareIp = (results?.[0]?.[1] as number) || 1;

      // Se atingiu o limite, dispara alerta deduplicado ao operador (E2.3-e)
      if (countShareIp === this.MAX_ATTEMPTS_SHARE_IP && workspaceId && taskId) {
        this.notifyAbuseThresholdReached(workspaceId, taskId, shareTokenHash, ip).catch(() => {});
      }

      const remaining = Math.max(0, this.MAX_ATTEMPTS_SHARE_IP - countShareIp);
      return {
        remainingAttempts: remaining,
        retryAfterSeconds: countShareIp >= this.MAX_ATTEMPTS_SHARE_IP ? this.WINDOW_SECONDS : undefined,
      };
    } catch (err) {
      return { remainingAttempts: 0, retryAfterSeconds: this.WINDOW_SECONDS };
    }
  }

  /**
   * Limpa os contadores após validação bem-sucedida do PIN.
   */
  static async resetAttempts(shareTokenHash: string, ip: string): Promise<void> {
    const redis = getRedisClient();
    try {
      const keyShareIp = `rl:share_ip:${shareTokenHash}:${ip}`;
      await redis.del(keyShareIp).catch(() => {});
    } catch (err) {}
  }

  /**
   * Notificação interna deduplicada enviada quando o limite de tentativas é atingido (E2.3-e).
   */
  private static async notifyAbuseThresholdReached(
    workspaceId: string,
    taskId: string,
    shareTokenHash: string,
    ip: string
  ): Promise<void> {
    const redis = getRedisClient();
    const dedupKey = `abuse_notified:${shareTokenHash}`;

    // Deduplica notificação por 30 minutos no Redis
    const alreadyNotified = await redis.set(dedupKey, '1', 'EX', 1800, 'NX').catch(() => null);
    if (!alreadyNotified) return;

    // Registra notificação interna na central de notificações
    // Busca os membros ADMIN do workspace
    await NotificationService.notifyWorkspaceAdmins({
      workspaceId,
      taskId,
      title: 'Alerta de Segurança: Tentativas Excessivas de PIN',
      content: `O link público da tarefa recebeu 5 tentativas incorretas de PIN originadas do IP ${ip} e foi temporariamente bloqueado por 15 minutos. Caso necessário, revogue o link.`,
      type: 'security_alert',
    }).catch(() => {});
  }
}
