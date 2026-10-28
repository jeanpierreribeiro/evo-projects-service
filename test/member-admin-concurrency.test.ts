import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { WorkspaceService } from '../src/services/workspace.service.js';
import { ForbiddenError } from '../src/errors/app-error.js';
import { UserActor } from '../src/types/auth.js';
import { WorkspaceRole } from '@prisma/client';

describe('E3.5-f / T05 - Proteção Concorrente do Último ADMIN (WorkspaceService)', () => {
  let workspaceId: string;
  let adminActor: UserActor;
  let admin1MemberId: string;
  let admin2MemberId: string;

  beforeEach(async () => {
    // 1. Cria um workspace exclusivo com exatamente 2 ADMINs
    const ws = await prisma.workspace.create({
      data: {
        name: `WS Concurrency Test ${Date.now()}`,
        slug: `ws-conc-${Date.now()}`,
        members: {
          create: [
            {
              userId: `usr-admin-1-${Date.now()}`,
              email: `admin1-${Date.now()}@corp.local`,
              name: 'Admin One',
              role: WorkspaceRole.ADMIN,
              status: 'ACTIVE',
            },
            {
              userId: `usr-admin-2-${Date.now()}`,
              email: `admin2-${Date.now()}@corp.local`,
              name: 'Admin Two',
              role: WorkspaceRole.ADMIN,
              status: 'ACTIVE',
            },
          ],
        },
      },
      include: {
        members: { orderBy: { createdAt: 'asc' } },
      },
    });

    workspaceId = ws.id;
    admin1MemberId = ws.members[0].id;
    admin2MemberId = ws.members[1].id;

    adminActor = {
      type: 'user',
      id: ws.members[0].userId,
      role: 'ADMIN',
      tokenWorkspaceId: workspaceId,
    };
  });

  afterEach(async () => {
    if (workspaceId) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    }
  });

  it('deve bloquear rebaixamento do último ADMIN com 403 Forbidden', async () => {
    // 1. Remove admin2 para que admin1 fique como o único ADMIN
    await WorkspaceService.removeMember(workspaceId, admin2MemberId, adminActor);

    // 2. Tenta rebaixar admin1 para MEMBER -> deve lançar ForbiddenError
    await expect(
      WorkspaceService.updateMemberRole(workspaceId, admin1MemberId, WorkspaceRole.MEMBER, adminActor)
    ).rejects.toThrow(ForbiddenError);

    // 3. Tenta remover admin1 -> deve lançar ForbiddenError
    await expect(
      WorkspaceService.removeMember(workspaceId, admin1MemberId, adminActor)
    ).rejects.toThrow(ForbiddenError);
  });

  it('em duas remoções simultâneas dos únicos 2 ADMINs, exatamente uma deve ter sucesso e a outra falhar com 403 (E3.5-f / T05)', async () => {
    // Dispara remoção simultânea de ambos os administradores
    const results = await Promise.allSettled([
      WorkspaceService.removeMember(workspaceId, admin1MemberId, adminActor),
      WorkspaceService.removeMember(workspaceId, admin2MemberId, adminActor),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exatamente 1 deve ter sido removido com sucesso
    expect(fulfilled.length).toBe(1);
    // E exatamente 1 deve ter sido rejeitado
    expect(rejected.length).toBe(1);

    // O erro rejeitado deve ser ForbiddenError
    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(ForbiddenError);
    expect(rejectionReason.message).toContain('Não é permitido remover o único administrador');

    // Verifica no banco de dados que exatamente 1 ADMIN permanece ativo
    const remainingAdmins = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: WorkspaceRole.ADMIN,
        status: 'ACTIVE',
      },
    });

    expect(remainingAdmins).toBe(1);
  });

  it('em dois rebaixamentos simultâneos dos únicos 2 ADMINs, exatamente um deve ser rebaixado e o outro rejeitado com 403', async () => {
    const results = await Promise.allSettled([
      WorkspaceService.updateMemberRole(workspaceId, admin1MemberId, WorkspaceRole.MEMBER, adminActor),
      WorkspaceService.updateMemberRole(workspaceId, admin2MemberId, WorkspaceRole.MEMBER, adminActor),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(ForbiddenError);
    expect(rejectionReason.message).toContain('Não é permitido rebaixar o único administrador');

    const remainingAdmins = await prisma.workspaceMember.count({
      where: {
        workspaceId,
        role: WorkspaceRole.ADMIN,
        status: 'ACTIVE',
      },
    });

    expect(remainingAdmins).toBe(1);
  });
});
