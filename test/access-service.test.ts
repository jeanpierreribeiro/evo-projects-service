import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccessService } from '../src/services/access.service.js';
import { Actor, UserActor } from '../src/types/auth.js';
import prisma from '../src/db/prisma.js';
import { ForbiddenError, NotFoundError } from '../src/errors/app-error.js';

// Mock do prisma para testes unitários isolados da matriz de políticas
vi.mock('../src/db/prisma.js', () => ({
  default: {
    workspaceMember: {
      findUnique: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
    },
    column: {
      findUnique: vi.fn(),
    },
    task: {
      findUnique: vi.fn(),
    },
  },
}));

describe('E1.4 - AccessService e Matriz de Autorização (T04)', () => {
  const workspaceId = 'ws-test-123';
  const otherWorkspaceId = 'ws-other-456';

  const viewerActor: UserActor = {
    type: 'user',
    id: 'user-viewer-1',
    email: 'viewer@jpros.local',
    name: 'Viewer User',
  };

  const memberActor: UserActor = {
    type: 'user',
    id: 'user-member-1',
    email: 'member@jpros.local',
    name: 'Member User',
  };

  const adminActor: UserActor = {
    type: 'user',
    id: 'user-admin-1',
    email: 'admin@jpros.local',
    name: 'Admin User',
  };

  const superAdminGlobalActor: UserActor = {
    type: 'user',
    id: 'user-superadmin-global',
    email: 'superadmin@jpros.local',
    name: 'Global SuperAdmin',
    role: 'super_admin', // Claim global do Auth
  };

  const nonMemberActor: UserActor = {
    type: 'user',
    id: 'user-outsider',
    email: 'outsider@jpros.local',
    name: 'Outsider User',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Configura o mock do Prisma para resolver o papel do usuário no workspaceId
    (prisma.workspaceMember.findUnique as any).mockImplementation(
      ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) => {
        const { workspaceId: ws, userId } = where.workspaceId_userId;
        if (ws !== workspaceId) return null;

        if (userId === viewerActor.id) return { role: 'VIEWER' };
        if (userId === memberActor.id) return { role: 'MEMBER' };
        if (userId === adminActor.id) return { role: 'ADMIN' };
        // superAdminGlobalActor e nonMemberActor não possuem registro em workspace_members
        return null;
      }
    );
  });

  describe('Ausência de bypass global por super_admin (Seção 3.5)', () => {
    it('deve recusar super_admin global que não possua membership explícito no workspace', async () => {
      const decision = await AccessService.can(superAdminGlobalActor, 'read_workspace', {
        workspaceId,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('NOT_MEMBER');

      await expect(
        AccessService.assertCan(superAdminGlobalActor, 'read_workspace', { workspaceId })
      ).rejects.toThrow(NotFoundError);
    });

    it('deve recusar usuário não-membro', async () => {
      const decision = await AccessService.can(nonMemberActor, 'read_workspace', { workspaceId });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('NOT_MEMBER');
    });
  });

  describe('Papel VIEWER (Leitura permitida, escrita proibida)', () => {
    it('deve permitir leituras operacionais', async () => {
      const readActions = [
        'read_workspace',
        'read_project',
        'read_column',
        'read_task',
        'read_operational_history',
        'read_internal_comments',
        'read_dashboard',
      ];

      for (const action of readActions) {
        const decision = await AccessService.can(viewerActor, action, { workspaceId });
        expect(decision.allowed, `Falha na ação de leitura: ${action}`).toBe(true);
      }
    });

    it('deve proibir criação ou edição de tarefas e recursos para VIEWER', async () => {
      const writeActions = [
        'create_task',
        'edit_task',
        'move_task',
        'create_subtask',
        'create_comment',
        'create_time_entry',
        'share_task',
      ];

      for (const action of writeActions) {
        const decision = await AccessService.can(viewerActor, action, { workspaceId });
        expect(decision.allowed, `VIEWER não deveria poder executar: ${action}`).toBe(false);
        expect(decision.reason).toBe('VIEWER_CANNOT_WRITE');

        await expect(
          AccessService.assertCan(viewerActor, action, { workspaceId })
        ).rejects.toThrow(ForbiddenError);
      }
    });

    it('deve proibir ações administrativas para VIEWER', async () => {
      const decision = await AccessService.can(viewerActor, 'manage_members', { workspaceId });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('REQUIRES_ADMIN');
    });
  });

  describe('Papel MEMBER (Colaboração e autoria)', () => {
    it('deve permitir criar e editar tarefas e recursos de colaboração', async () => {
      const memberActions = [
        'create_task',
        'edit_task',
        'move_task',
        'create_subtask',
        'edit_subtask',
        'delete_subtask',
        'create_relation',
        'delete_relation',
        'create_resource',
        'delete_resource',
        'create_comment',
        'create_time_entry',
        'share_task',
      ];

      for (const action of memberActions) {
        const decision = await AccessService.can(memberActor, action, { workspaceId });
        expect(decision.allowed, `MEMBER deveria poder executar: ${action}`).toBe(true);
      }
    });

    it('deve permitir editar e excluir APENAS os próprios comentários e horas', async () => {
      // Próprio comentário
      const ownComment = await AccessService.can(memberActor, 'edit_comment', {
        workspaceId,
        authorId: memberActor.id,
      });
      expect(ownComment.allowed).toBe(true);

      // Comentário de outro usuário
      const otherComment = await AccessService.can(memberActor, 'edit_comment', {
        workspaceId,
        authorId: 'someone-else-id',
      });
      expect(otherComment.allowed).toBe(false);
      expect(otherComment.reason).toBe('NOT_RESOURCE_AUTHOR');

      // Próprio apontamento de tempo
      const ownTime = await AccessService.can(memberActor, 'delete_time_entry', {
        workspaceId,
        authorId: memberActor.id,
      });
      expect(ownTime.allowed).toBe(true);

      // Apontamento de tempo de outro usuário
      const otherTime = await AccessService.can(memberActor, 'delete_time_entry', {
        workspaceId,
        authorId: 'someone-else-id',
      });
      expect(otherTime.allowed).toBe(false);
      expect(otherTime.reason).toBe('NOT_RESOURCE_AUTHOR');
    });

    it('deve proibir ações administrativas de projeto e workspace para MEMBER', async () => {
      const adminActions = [
        'manage_workspace',
        'archive_workspace',
        'delete_workspace',
        'manage_members',
        'create_project',
        'manage_project',
        'archive_project',
        'delete_project',
        'manage_columns',
        'manage_tags',
        'manage_custom_fields',
        'delete_task',
      ];

      for (const action of adminActions) {
        const decision = await AccessService.can(memberActor, action, { workspaceId });
        expect(decision.allowed, `MEMBER não deveria poder executar: ${action}`).toBe(false);
        expect(decision.reason).toBe('REQUIRES_ADMIN');

        await expect(
          AccessService.assertCan(memberActor, action, { workspaceId })
        ).rejects.toThrow(ForbiddenError);
      }
    });

    it('não deve permitir MEMBER restaurar tarefa se o projeto estiver arquivado', async () => {
      const decision = await AccessService.can(memberActor, 'restore_task', {
        workspaceId,
        isProjectArchived: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('ARCHIVED_PARENT_REQUIRES_ADMIN');
    });
  });

  describe('Papel ADMIN (Gestão completa e auditoria)', () => {
    it('deve permitir todas as ações administrativas', async () => {
      const adminActions = [
        'manage_workspace',
        'archive_workspace',
        'delete_workspace',
        'manage_members',
        'create_project',
        'manage_project',
        'archive_project',
        'delete_project',
        'manage_columns',
        'manage_tags',
        'manage_custom_fields',
        'delete_task',
      ];

      for (const action of adminActions) {
        const decision = await AccessService.can(adminActor, action, { workspaceId });
        expect(decision.allowed, `ADMIN deveria poder executar: ${action}`).toBe(true);
      }
    });

    it('deve permitir ADMIN editar ou excluir comentários e horas de outros usuários', async () => {
      const editOtherComment = await AccessService.can(adminActor, 'edit_comment', {
        workspaceId,
        authorId: 'someone-else-id',
      });
      expect(editOtherComment.allowed).toBe(true);

      const deleteOtherTime = await AccessService.can(adminActor, 'delete_time_entry', {
        workspaceId,
        authorId: 'someone-else-id',
      });
      expect(deleteOtherTime.allowed).toBe(true);
    });

    it('deve permitir ADMIN restaurar tarefa mesmo com projeto arquivado', async () => {
      const decision = await AccessService.can(adminActor, 'restore_task', {
        workspaceId,
        isProjectArchived: true,
      });
      expect(decision.allowed).toBe(true);
    });
  });

  describe('Inbox Privado (E1.4-d / Seção 3.2)', () => {
    it('deve permitir a qualquer membro ler suas próprias notificações', async () => {
      const decision = await AccessService.can(viewerActor, 'read_own_notifications', {
        workspaceId,
        targetUserId: viewerActor.id,
      });
      expect(decision.allowed).toBe(true);
    });

    it('ADMIN NÃO pode acessar o inbox de outro membro', async () => {
      const decision = await AccessService.can(adminActor, 'read_own_notifications', {
        workspaceId,
        targetUserId: memberActor.id, // Tentativa do ADMIN de ler inbox do MEMBER
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('INBOX_PRIVATE_TO_RECIPIENT');

      await expect(
        AccessService.assertCan(adminActor, 'read_own_notifications', {
          workspaceId,
          targetUserId: memberActor.id,
        })
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('Verificação de hierarquia e isolamento pai-filho', () => {
    it('deve rejeitar projeto se esperado outro workspace', async () => {
      (prisma.project.findUnique as any).mockResolvedValue({
        id: 'proj-1',
        workspaceId: otherWorkspaceId, // Pertence a outro workspace!
        isArchived: false,
      });

      await expect(
        AccessService.getAuthorizedProject('proj-1', adminActor, 'read_project', workspaceId)
      ).rejects.toThrow(NotFoundError);
    });

    it('deve rejeitar coluna se esperada em outro projeto', async () => {
      (prisma.column.findUnique as any).mockResolvedValue({
        id: 'col-1',
        projectId: 'proj-other',
        project: { id: 'proj-other', workspaceId, isArchived: false },
      });

      await expect(
        AccessService.getAuthorizedColumn('col-1', adminActor, 'manage_columns', 'proj-1')
      ).rejects.toThrow(NotFoundError);
    });
  });
});
