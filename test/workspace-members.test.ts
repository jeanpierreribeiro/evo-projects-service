import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceService } from '../src/services/workspace.service.js';
import { reconcileLegacyMembers } from '../scripts/reconcile-members/reconcile.js';
import prisma from '../src/db/prisma.js';
import { ConflictError, ForbiddenError } from '../src/errors/app-error.js';
import { Actor, UserActor } from '../src/types/auth.js';

// Mock do prisma para testes determinísticos de ciclo de vida de membros
vi.mock('../src/db/prisma.js', () => ({
  default: {
    workspaceMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    userProjection: {
      findMany: vi.fn(),
    },
    task: {
      updateMany: vi.fn(),
    },
    timeEntry: {
      updateMany: vi.fn(),
    },
    comment: {
      updateMany: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    activity: {
      create: vi.fn(),
    },
    taskShare: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    taskShareSession: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn().mockImplementation((args) => (Array.isArray(args) ? Promise.all(args) : args(prisma))),
  },
}));

describe('T05 - Ciclo de Vida de Membros, Idempotência e Último ADMIN (E1.6)', () => {
  const workspaceId = 'ws-test-members-123';
  const adminActor: UserActor = {
    type: 'user',
    id: 'usr-admin-1',
    email: 'admin@corp.com',
    name: 'Admin User',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock do AccessService / membership do adminActor
    (prisma.workspaceMember.findUnique as any).mockImplementation(({ where }: any) => {
      if (where.workspaceId_userId) {
        const { workspaceId: ws, userId } = where.workspaceId_userId;
        if (ws === workspaceId && userId === adminActor.id) {
          return { role: 'ADMIN', active: true };
        }
      }
      return null;
    });
  });

  describe('Adição de membros e conflito de duplicidade', () => {
    it('deve adicionar novo membro por ID canônico', async () => {
      (prisma.workspaceMember.create as any).mockResolvedValue({
        id: 'member-new-1',
        workspaceId,
        userId: 'usr-canonical-99',
        email: 'novo@corp.com',
        name: 'Novo Membro',
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      const member = await WorkspaceService.addMember(
        workspaceId,
        {
          userId: 'usr-canonical-99',
          email: 'novo@corp.com',
          name: 'Novo Membro',
          role: 'MEMBER',
        },
        adminActor
      );

      expect(member.id).toBe('member-new-1');
      expect(prisma.workspaceMember.create).toHaveBeenCalled();
    });

    it('deve rejeitar com 409 Conflict caso o usuário já seja membro', async () => {
      (prisma.workspaceMember.findUnique as any).mockImplementation(({ where }: any) => {
        if (where.workspaceId_userId) {
          const { userId } = where.workspaceId_userId;
          if (userId === adminActor.id) {
            return { role: 'ADMIN', active: true };
          }
          if (userId === 'usr-already-member') {
            return { role: 'MEMBER', active: true }; // Já existe!
          }
        }
        return null;
      });

      await expect(
        WorkspaceService.addMember(
          workspaceId,
          {
            userId: 'usr-already-member',
            email: 'existing@corp.com',
            name: 'Membro Existente',
          },
          adminActor
        )
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('Proteção contra exclusão do último ADMIN', () => {
    it('deve PROIBIR a remoção do único administrador do workspace', async () => {
      // Mock do membro a ser removido (é ADMIN)
      (prisma.workspaceMember.findUnique as any).mockImplementation(({ where }: any) => {
        if (where.id === 'member-admin-only') {
          return {
            id: 'member-admin-only',
            workspaceId,
            userId: 'usr-admin-1',
            role: 'ADMIN',
          };
        }
        if (where.workspaceId_userId) {
          return { role: 'ADMIN', active: true };
        }
        return null;
      });

      // Contagem de admins no workspace é apenas 1
      (prisma.workspaceMember.count as any).mockResolvedValue(1);

      await expect(
        WorkspaceService.removeMember(workspaceId, 'member-admin-only', adminActor)
      ).rejects.toThrow(ForbiddenError);

      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it('deve PERMITIR a remoção de um administrador se houver outro ADMIN ativo', async () => {
      (prisma.workspaceMember.findUnique as any).mockImplementation(({ where }: any) => {
        if (where.id === 'member-admin-2') {
          return {
            id: 'member-admin-2',
            workspaceId,
            userId: 'usr-admin-2',
            role: 'ADMIN',
            name: 'Segundo Admin',
          };
        }
        if (where.workspaceId_userId) {
          return { role: 'ADMIN', active: true };
        }
        return null;
      });

      // Contagem de admins no workspace é 2
      (prisma.workspaceMember.count as any).mockResolvedValue(2);
      (prisma.workspaceMember.delete as any).mockResolvedValue({
        id: 'member-admin-2',
        name: 'Segundo Admin',
      });

      const result = await WorkspaceService.removeMember(workspaceId, 'member-admin-2', adminActor);
      expect(result.id).toBe('member-admin-2');
      expect(prisma.workspaceMember.delete).toHaveBeenCalled();
    });
  });

  describe('Reconciliação de identidades legadas (E1.6-f)', () => {
    it('deve reconciliar e-mail para usuário único e deixar pendente e-mails ambíguos', async () => {
      // Mock de membros legados no banco
      (prisma.workspaceMember.findMany as any).mockResolvedValue([
        {
          id: 'mem-legacy-1',
          workspaceId: 'ws-1',
          userId: 'carlos@jpros.local', // E-mail usado como userId legado
          email: 'carlos@jpros.local',
        },
        {
          id: 'mem-legacy-2',
          workspaceId: 'ws-2',
          userId: 'ambiguo@jpros.local',
          email: 'ambiguo@jpros.local',
        },
      ]);

      // Mock da busca de projeção
      (prisma.userProjection.findMany as any).mockImplementation(({ where }: any) => {
        if (where.email === 'carlos@jpros.local') {
          return [{ id: 'usr-uuid-carlos-123', name: 'Carlos Canônico', email: 'carlos@jpros.local' }];
        }
        if (where.email === 'ambiguo@jpros.local') {
          return [
            { id: 'usr-uuid-1', name: 'Ambíguo 1', email: 'ambiguo@jpros.local' },
            { id: 'usr-uuid-2', name: 'Ambíguo 2', email: 'ambiguo@jpros.local' },
          ];
        }
        return [];
      });

      const result = await reconcileLegacyMembers(false); // Modo aplicar

      expect(result.reconciled).toBe(1);
      expect(result.pendingReview).toBe(1);
      expect(result.unresolvedEmails).toContain('ambiguo@jpros.local');

      // Verifica que o membro do Carlos foi atualizado para o UUID canônico
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: 'mem-legacy-1' },
        data: { userId: 'usr-uuid-carlos-123', status: 'ACTIVE' },
      });

      // Verifica que o ambíguo foi marcado como PENDING para não assumir ID incorreto
      expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
        where: { id: 'mem-legacy-2' },
        data: { status: 'PENDING' },
      });
    });
  });
});
