import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { TaskService } from '../src/services/task.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { WorkspaceService } from '../src/services/workspace.service.js';
import { TransferService } from '../src/services/transfer.service.js';
import { NotificationService } from '../src/services/notification.service.js';
import { ActivityService, sanitizeAuditDetails } from '../src/services/activity.service.js';
import { ShareService } from '../src/services/share.service.js';
import { Actor } from '../src/types/auth.js';
import { RelationType } from '@prisma/client';
import { ValidationError, NotFoundError, ForbiddenError } from '../src/errors/app-error.js';

describe('E3.6 & T14 - Auditoria Definitiva, Notificações, Menções, Ciclo de Vida e Transferência', () => {
  let workspaceId: string;
  let projectAId: string;
  let projectBId: string;
  let adminActor: Actor;
  let memberActor: Actor;
  let adminUserId: string;
  let memberUserId: string;

  beforeEach(async () => {
    // Busca o workspace seed principal com membros
    const ws = await prisma.workspace.findUnique({
      where: { slug: 'operacao-principal' },
      include: { members: true },
    });

    if (!ws) {
      throw new Error('Workspace seed "operacao-principal" não encontrado');
    }

    workspaceId = ws.id;

    const admin = ws.members.find((m) => m.role === 'ADMIN' && m.status === 'ACTIVE');
    if (!admin) {
      throw new Error('Admin ativo não encontrado no workspace');
    }

    // Garante membro com role MEMBER ativo para os testes de matriz de ciclo de vida
    const member = await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: ws.id,
          userId: 'test-member-lifecycle-user-id',
        },
      },
      create: {
        workspaceId: ws.id,
        userId: 'test-member-lifecycle-user-id',
        email: 'member-lifecycle@jpros.local',
        name: 'Membro Teste',
        role: 'MEMBER',
        status: 'ACTIVE',
      },
      update: {
        role: 'MEMBER',
        status: 'ACTIVE',
      },
    });

    adminUserId = admin.userId;
    memberUserId = member.userId;

    adminActor = {
      type: 'user',
      id: adminUserId,
      role: 'ADMIN',
      tokenWorkspaceId: workspaceId,
    };

    memberActor = {
      type: 'user',
      id: memberUserId,
      role: 'MEMBER',
      tokenWorkspaceId: workspaceId,
    };

    // Cria dois projetos limpos no mesmo workspace
    const randA = Math.random().toString(36).substring(2, 6).toUpperCase();
    const randB = Math.random().toString(36).substring(2, 6).toUpperCase();

    const pA = await ProjectService.createProject(
      workspaceId,
      { name: `Projeto Origem ${randA}`, key: `ORG${randA}` },
      adminActor
    );
    projectAId = pA.id;

    const pB = await ProjectService.createProject(
      workspaceId,
      { name: `Projeto Destino ${randB}`, key: `DST${randB}` },
      adminActor
    );
    projectBId = pB.id;
  });

  describe('3.6-a: Activity Definitiva & Desacoplamento Histórico', () => {
    it('deve sanitizar detalhes removendo segredos, senhas e PINs de auditoria', () => {
      const dirty = {
        title: 'Nova Tarefa',
        pin: '123456',
        token: 'secret-token-abc',
        nested: {
          clientPassword: 'my-password',
          safeField: 'valor permitido',
        },
      };

      const clean = sanitizeAuditDetails(dirty);
      expect(clean.title).toBe('Nova Tarefa');
      expect(clean.pin).toBe('[REDACTED]');
      expect(clean.token).toBe('[REDACTED]');
      expect(clean.nested.clientPassword).toBe('[REDACTED]');
      expect(clean.nested.safeField).toBe('valor permitido');
    });

    it('deve gravar Activity com ator estruturado e mantê-la após soft delete', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa para Auditoria' },
        adminActor
      );

      const activity = await ActivityService.log({
        workspaceId,
        projectId: projectAId,
        taskId: task.id,
        actor: {
          ...adminActor,
          initiatedByUserId: 'delegator-123',
          requestId: 'req-abc-999',
        },
        action: 'custom.audit_test',
        details: { note: 'registro permanente' },
      });

      expect(activity.actorType).toBe('USER');
      expect(activity.actorId).toBe(adminActor.id);
      expect(activity.initiatedByUserId).toBe('delegator-123');
      expect(activity.requestId).toBe('req-abc-999');

      // Exclui a tarefa logicamente
      await TaskService.deleteTask(task.id, adminActor, 'motivo teste');

      // A Activity permanece no banco e ainda aponta para o taskId
      const found = await prisma.activity.findUnique({
        where: { id: activity.id },
      });
      expect(found).not.toBeNull();
      expect(found?.action).toBe('custom.audit_test');
    });
  });

  describe('3.6-b: Notificações com Arquivamento e Deduplicação', () => {
    it('não deve notificar o próprio autor da ação', async () => {
      const notif = await NotificationService.create({
        workspaceId,
        userId: adminActor.id,
        actorId: adminActor.id, // mesmo autor
        title: 'Auto-notificação',
        content: 'Não deve ser criada',
      });

      expect(notif).toBeNull();
    });

    it('deve deduplicar notificações por dedupKey sem criar registros duplicados', async () => {
      const dedupKey = `test_dedup_${Date.now()}`;

      const notif1 = await NotificationService.create({
        workspaceId,
        userId: memberActor.id,
        actorId: adminActor.id,
        title: 'Notificação 1',
        content: 'Conteúdo 1',
        dedupKey,
      });

      const notif2 = await NotificationService.create({
        workspaceId,
        userId: memberActor.id,
        actorId: adminActor.id,
        title: 'Notificação Atualizada',
        content: 'Conteúdo Atualizado',
        dedupKey,
      });

      expect(notif1).not.toBeNull();
      expect(notif2).not.toBeNull();
      expect(notif1?.id).toBe(notif2?.id); // Mesmo ID reusado/atualizado via upsert

      const count = await prisma.notification.count({
        where: { workspaceId, userId: memberActor.id, dedupKey },
      });
      expect(count).toBe(1);
    });

    it('deve arquivar, desarquivar e filtrar notificações no inbox', async () => {
      const notif = await NotificationService.create({
        workspaceId,
        userId: memberActor.id,
        actorId: adminActor.id,
        title: 'Para Arquivar',
        content: 'Corpo',
      });

      expect(notif).not.toBeNull();

      // Arquiva a notificação
      await NotificationService.archive(notif!.id, memberActor);

      // Listagem padrão esconde notificações arquivadas
      const standardList = await NotificationService.listByUser(workspaceId, memberActor);
      const inStandard = standardList.data.some((n: any) => n.id === notif!.id);
      expect(inStandard).toBe(false);

      // Listagem com includeArchived mostra
      const fullList = await NotificationService.listByUser(workspaceId, memberActor, {
        includeArchived: true,
      });
      const inFull = fullList.data.some((n: any) => n.id === notif!.id);
      expect(inFull).toBe(true);

      // Desarquiva
      await NotificationService.unarchive(notif!.id, memberActor);
      const afterUnarchive = await NotificationService.listByUser(workspaceId, memberActor);
      expect(afterUnarchive.data.some((n: any) => n.id === notif!.id)).toBe(true);
    });
  });

  describe('3.6-c: Menções em Comentários (CommentMention)', () => {
    it('deve registrar CommentMention e notificar membro mencionado', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa com Comentário' },
        adminActor
      );

      const comment = await TaskService.addComment(
        task.id,
        'Olá @membro veja isso',
        adminActor,
        [memberUserId]
      );

      expect(comment.mentions).toHaveLength(1);
      expect(comment.mentions[0].userId).toBe(memberUserId);

      // Notificação gerada para o membro mencionado
      const notif = await prisma.notification.findFirst({
        where: {
          workspaceId,
          userId: memberUserId,
          type: 'mention',
          dedupKey: `task_mention:${comment.id}:${memberUserId}`,
        },
      });
      expect(notif).not.toBeNull();
    });

    it('na edição de comentário, deve notificar SOMENTE novas menções adicionadas', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa Edição Menção' },
        adminActor
      );

      // Cria comentário com menção inicial a memberUserId
      const comment = await TaskService.addComment(
        task.id,
        'Comentário inicial',
        adminActor,
        [memberUserId]
      );

      const countBefore = await prisma.notification.count({
        where: {
          workspaceId,
          userId: memberUserId,
          dedupKey: `task_mention:${comment.id}:${memberUserId}`,
        },
      });
      expect(countBefore).toBe(1);

      // Edita o comentário mantendo memberUserId (não deve criar nova notificação para ele)
      await TaskService.updateComment(
        comment.id,
        'Comentário editado',
        adminActor,
        [memberUserId]
      );

      const countAfter = await prisma.notification.count({
        where: {
          workspaceId,
          userId: memberUserId,
          dedupKey: `task_mention:${comment.id}:${memberUserId}`,
        },
      });
      expect(countAfter).toBe(1);
    });
  });

  describe('3.6-d & T14: Ciclo de Vida (Arquivar, Excluir Logicamente e Restaurar)', () => {
    it('MEMBER pode arquivar e restaurar tarefa em projeto ativo', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa do Membro' },
        memberActor
      );

      // Arquiva
      const archived = await TaskService.archiveTask(task.id, memberActor);
      expect(archived.isArchived).toBe(true);

      // Tarefa arquivada é excluída da listagem do projeto
      const list = await TaskService.listByProject(projectAId, memberActor);
      expect(list.data.some((t) => t.id === task.id)).toBe(false);

      // Tarefa arquivada é somente leitura: tentativa de mover deve falhar
      const col = await prisma.column.findFirstOrThrow({ where: { projectId: projectAId } });
      await expect(
        TaskService.moveTask(task.id, col.id, 0, memberActor)
      ).rejects.toThrow(ForbiddenError);

      // Restaura
      const restored = await TaskService.restoreTask(task.id, memberActor);
      expect(restored.isArchived).toBe(false);

      // Volta a aparecer na listagem
      const listAfter = await TaskService.listByProject(projectAId, memberActor);
      expect(listAfter.data.some((t) => t.id === task.id)).toBe(true);
    });

    it('arquivar tarefa revoga compartilhamentos públicos; restauração NÃO os reativa (T14)', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa com Share' },
        adminActor
      );

      // Cria um compartilhamento público por PIN
      const share = await ShareService.createShare(
        adminActor,
        task.id,
        { pin: '123456', expiresInDays: 7 }
      );
      expect(share.shareId).toBeDefined();

      const dbShareBefore = await prisma.taskShare.findFirstOrThrow({
        where: { taskId: task.id },
      });
      expect(dbShareBefore.revokedAt).toBeNull();

      // Arquiva a tarefa
      await TaskService.archiveTask(task.id, adminActor);

      // Share foi revogado em cascata
      const checkShare = await prisma.taskShare.findUniqueOrThrow({
        where: { id: dbShareBefore.id },
      });
      expect(checkShare.revokedAt).not.toBeNull();

      // Restaura a tarefa
      await TaskService.restoreTask(task.id, adminActor);

      // Share permanece revogado (não é reativado)
      const afterRestoreShare = await prisma.taskShare.findUniqueOrThrow({
        where: { id: dbShareBefore.id },
      });
      expect(afterRestoreShare.revokedAt).not.toBeNull();
    });

    it('excluir logicamente oculta a tarefa; MEMBER não pode restaurar; ADMIN pode restaurar (T14)', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa Soft Delete' },
        adminActor
      );

      // ADMIN exclui logicamente
      await TaskService.deleteTask(task.id, adminActor, 'motivo arquivamento');

      // Consulta direta por ID deve retornar NotFoundError (invisível para operações normais)
      await expect(TaskService.getTask(task.id, memberActor)).rejects.toThrow(NotFoundError);

      // MEMBER tenta restaurar tarefa excluída: RECUSADO (apenas ADMIN pode)
      await expect(TaskService.restoreTask(task.id, memberActor)).rejects.toThrow(ForbiddenError);

      // ADMIN restaura tarefa excluída: PERMITIDO
      const restored = await TaskService.restoreTask(task.id, adminActor);
      expect(restored.id).toBe(task.id);

      // Agora a tarefa volta a ser visível
      const visible = await TaskService.getTask(task.id, memberActor);
      expect(visible.id).toBe(task.id);
    });

    it('tarefa filha de projeto arquivado fica em modo somente leitura (T14)', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa em Projeto Ativo' },
        adminActor
      );

      // Arquiva a tarefa ANTES de arquivar o projeto pai
      await TaskService.archiveTask(task.id, adminActor);

      // Arquiva o projeto pai
      await ProjectService.archiveProject(projectAId, adminActor);

      // Leitura direta da tarefa funciona
      const taskDTO = await TaskService.getTask(task.id, memberActor);
      expect(taskDTO.id).toBe(task.id);

      // Modificação na tarefa filha é bloqueada porque o container pai está arquivado
      await expect(
        TaskService.updateTask(task.id, { title: 'Tentativa de alteracao' }, memberActor)
      ).rejects.toThrow(ForbiddenError);

      // MEMBER não pode restaurar tarefa cujo projeto pai está arquivado (exige ADMIN)
      await expect(TaskService.restoreTask(task.id, memberActor)).rejects.toThrow(ForbiddenError);

      // ADMIN pode restaurar tarefa mesmo com container arquivado
      const restored = await TaskService.restoreTask(task.id, adminActor);
      expect(restored.isArchived).toBe(false);
    });

    it('tarefa filha de projeto excluído logicamente é invisível (NotFoundError) (T14)', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa em Projeto que sera Excluido' },
        adminActor
      );

      // Exclui logicamente o projeto pai
      await ProjectService.deleteProject(projectAId, adminActor, 'projeto descontinuado');

      // Tentativa de acessar a tarefa filha por link direto retorna NotFoundError
      await expect(TaskService.getTask(task.id, adminActor)).rejects.toThrow(NotFoundError);
    });
  });

  describe('3.6-e & T14: Transferência entre Projetos (/transfer/preview e /transfer)', () => {
    it('deve gerar prévia coerente com novo código, relações incompatíveis e shares a revogar', async () => {
      const task1 = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa Principal Origem' },
        adminActor
      );
      const task2 = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa Relacionada no Mesmo Projeto' },
        adminActor
      );

      // Cria relação entre elas (no projeto A)
      await TaskService.addRelation(task1.id, task2.id, RelationType.BLOCKS, adminActor);

      // Cria share público na task1
      await ShareService.createShare(adminActor, task1.id, { pin: '654321' });

      // Gera prévia de transferência para o Projeto B
      const preview = await TransferService.preview(task1.id, projectBId, adminActor);

      expect(preview.taskId).toBe(task1.id);
      expect(preview.sourceProject.id).toBe(projectAId);
      expect(preview.targetProject.id).toBe(projectBId);
      expect(preview.currentDisplayCode).toContain('ORG');
      expect(preview.projectedDisplayCode).toContain('DST');
      expect(preview.incompatibleRelationsCount).toBe(1);
      expect(preview.sharesToRevokeCount).toBe(1);
      expect(preview.targetColumns.length).toBeGreaterThan(0);
    });

    it('deve executar transferência transacional alocando novo número e revogando shares (T14)', async () => {
      const task = await TaskService.createTask(
        projectAId,
        { title: 'Tarefa para Transferir' },
        adminActor
      );

      // Adiciona comentário e subtarefa para verificar preservação
      await TaskService.addComment(task.id, 'Comentário histórico', adminActor);
      await TaskService.addSubtask(task.id, 'Subtarefa importante', adminActor);

      // Compartilhamento público que deve ser revogado
      await ShareService.createShare(adminActor, task.id, { pin: '987654' });

      const dbShare = await prisma.taskShare.findFirstOrThrow({
        where: { taskId: task.id },
      });
      expect(dbShare.revokedAt).toBeNull();

      // Coluna de destino no Projeto B
      const targetCol = await prisma.column.findFirstOrThrow({
        where: { projectId: projectBId },
      });

      // Executa a transferência
      const transferred = await TransferService.execute({
        taskId: task.id,
        targetProjectId: projectBId,
        targetColumnId: targetCol.id,
        actor: adminActor,
      });

      // ID mantido
      expect(transferred.id).toBe(task.id);
      expect(transferred.projectId).toBe(projectBId);
      expect(transferred.columnId).toBe(targetCol.id);
      expect(transferred.displayCode).toContain('DST');

      // Comentários e subtarefas foram preservados
      const comments = await prisma.comment.findMany({ where: { taskId: task.id } });
      expect(comments).toHaveLength(1);

      const subtasks = await prisma.subtask.findMany({ where: { taskId: task.id } });
      expect(subtasks).toHaveLength(1);

      // Share foi revogado
      const checkShare = await prisma.taskShare.findUniqueOrThrow({
        where: { id: dbShare.id },
      });
      expect(checkShare.revokedAt).not.toBeNull();

      // Auditoria registrou a transferência com ambos os códigos
      const activity = await prisma.activity.findFirst({
        where: {
          taskId: task.id,
          action: 'task.transferred',
        },
      });
      expect(activity).not.toBeNull();
      const details = activity?.details as any;
      expect(details.fromProjectId).toBe(projectAId);
      expect(details.toProjectId).toBe(projectBId);
      expect(details.fromDisplayCode).toBeDefined();
      expect(details.toDisplayCode).toBe(transferred.displayCode);
    });
  });
});
