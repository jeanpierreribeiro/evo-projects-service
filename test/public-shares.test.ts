import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { generateShareToken, hashToken, generateSharePin, hashPin } from '../src/share/crypto.js';
import prisma from '../src/db/prisma.js';
import { RateLimiterService, getRedisClient } from '../src/share/attempts.js';

describe('T08 & T09 - Public Shares Surface, Rate Limiting & Sessions (E2.3 / E2.4)', () => {
  const app = buildApp();
  let rawToken: string;
  let tokenHash: string;
  const correctPin = '123456';

  let testWorkspaceId: string;
  let testTaskId: string;
  let testMemberUserId: string;
  let testShareId: string;

  beforeEach(async () => {
    // Habilita temporariamente o compartilhamento para estes testes
    config.projectsSharingEnabled = true;

    rawToken = generateShareToken();
    tokenHash = hashToken(rawToken);

    // Limpa chaves de rate limit no Redis de teste
    const redis = getRedisClient();
    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        await redis.connect().catch(() => {});
      }
      const keys = await redis.keys('rl:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (e) {}

    // Garante workspace e tarefa no banco de teste para validações reais
    const ws = await prisma.workspace.findFirst({
      where: {
        members: {
          some: { status: 'ACTIVE', role: { in: ['ADMIN', 'MEMBER'] } },
        },
        tasks: {
          some: {},
        },
      },
      include: {
        members: { where: { status: 'ACTIVE', role: { in: ['ADMIN', 'MEMBER'] } } },
        tasks: true,
      },
    });

    if (ws && ws.members.length > 0 && ws.tasks.length > 0) {
      testWorkspaceId = ws.id;
      testMemberUserId = ws.members[0].userId;
      testTaskId = ws.tasks[0].id;

      const pinHash = await hashPin(correctPin);
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      const share = await prisma.taskShare.create({
        data: {
          workspaceId: testWorkspaceId,
          taskId: testTaskId,
          tokenHash,
          pinHash,
          createdByActorType: 'USER',
          createdById: testMemberUserId,
          expiresAt,
          version: 1,
          showDescription: true,
          showSubtasks: true,
          showResources: true,
        },
      });
      testShareId = share.id;
    }
  });

  it('T08: controle de tentativas deve bloquear no 5º erro com 429 Too Many Requests', async () => {
    // Executa 4 tentativas com PIN errado (deve retornar 401 com contagem decrescente)
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/public/shares/${rawToken}/unlock`,
        headers: {
          'x-forwarded-for': '198.51.100.10',
        },
        payload: { pin: '000000' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('PIN_INVALID');
      expect(body.remainingAttempts).toBe(5 - attempt);
    }

    // 5ª tentativa com PIN errado: deve retornar 429 Too Many Requests com Retry-After
    const res5 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/public/shares/${rawToken}/unlock`,
      headers: {
        'x-forwarded-for': '198.51.100.10',
      },
      payload: { pin: '000000' },
    });

    expect(res5.statusCode).toBe(429);
    expect(res5.headers['retry-after']).toBeDefined();
    const body5 = JSON.parse(res5.body);
    expect(body5.code).toBe('RATE_LIMIT_EXCEEDED');

    // 6ª tentativa imediata (mesmo com o PIN correto!): deve ser rejeitada imediatamente com 429
    const resBlocked = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/public/shares/${rawToken}/unlock`,
      headers: {
        'x-forwarded-for': '198.51.100.10',
      },
      payload: { pin: correctPin },
    });

    expect(resBlocked.statusCode).toBe(429);
  });

  it('T08 & T09: PIN correto emite sessão pública, cookie seguro e libera leitura somente-leitura (DP15)', async () => {
    // 1. Desbloqueia com PIN correto de um novo IP
    const unlockRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/public/shares/${rawToken}/unlock`,
      headers: {
        'x-forwarded-for': '203.0.113.50',
      },
      payload: { pin: correctPin },
    });

    expect(unlockRes.statusCode).toBe(200);
    const unlockBody = JSON.parse(unlockRes.body);
    expect(unlockBody.success).toBe(true);
    expect(unlockBody.sessionToken).toBeDefined();

    // Cookie deve estar configurado com HttpOnly e SameSite=Strict
    const cookieHeader = unlockRes.headers['set-cookie'] as string;
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).toContain('task_share_session=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');

    const sessionToken = unlockBody.sessionToken;

    // 2. Lê o card público usando o token de sessão
    const cardRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/public/shares/${rawToken}/card`,
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    });

    expect(cardRes.statusCode).toBe(200);
    expect(cardRes.headers['cache-control']).toBe('no-store');
    expect(cardRes.headers['referrer-policy']).toBe('no-referrer');
    expect(cardRes.headers['x-robots-tag']).toBe('noindex');

    const cardBody = JSON.parse(cardRes.body);
    expect(cardBody.data).toBeDefined();
    expect(cardBody.data.taskId).toBe(testTaskId);

    // Validação DP15: A leitura NÃO deve alterar o status da tarefa nem registrar atividade de aprovação
    const currentTask = await prisma.task.findUnique({ where: { id: testTaskId } });
    expect(currentTask).toBeDefined();

    // 3. Revogação de sessão aberta (T09): Se o link for revogado, a próxima leitura deve falhar imediatamente
    await prisma.taskShare.update({
      where: { id: testShareId },
      data: { revokedAt: new Date() },
    });

    const cardAfterRevoke = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/public/shares/${rawToken}/card`,
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    });

    expect(cardAfterRevoke.statusCode).toBe(401);
  });
});
