import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { resolveCrmContext } from '../src/crm/resolve.js';
import { TaskService } from '../src/services/task.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { UserActor } from '../src/types/auth.js';
import { NotFoundError, ValidationError } from '../src/errors/app-error.js';

describe('T16 - Resolução Determinística de Contexto CRM e Escopo de Atendimento (E4.2)', () => {
  let workspace1: any;
  let workspace2: any;
  let project1: any;
  let project2: any;
  let adminActor: UserActor;
  const crmInstanceId = `crm-inst-${Date.now()}`;

  beforeEach(async () => {
    // Busca ou cria workspaces de teste
    const ws = await prisma.workspace.findFirst({
      where: {
        slug: 'operacao-principal',
        members: { some: { status: 'ACTIVE', role: 'ADMIN' } },
      },
      include: {
        members: { where: { status: 'ACTIVE', role: 'ADMIN' } },
        projects: { where: { isArchived: false, deletedAt: null } },
      },
    });

    if (!ws || ws.members.length === 0) {
      throw new Error('Ambiente de teste sem workspace ativo.');
    }

    workspace1 = ws;
    const admin = ws.members[0];
    adminActor = {
      type: 'user',
      id: admin.userId,
      role: 'ADMIN',
      tokenWorkspaceId: ws.id,
    };

    project1 = ws.projects[0];
    if (!project1) {
      project1 = await ProjectService.createProject(
        ws.id,
        { name: 'Projeto CRM Alpha' },
        adminActor
      );
    }

    // Segundo workspace para testar ambiguidade multiempresa (DP14)
    let ws2 = await prisma.workspace.findFirst({
      where: {
        id: { not: ws.id },
        isArchived: false,
        deletedAt: null,
      },
      include: {
        projects: { where: { isArchived: false, deletedAt: null } },
      },
    });

    if (!ws2) {
      ws2 = await prisma.workspace.create({
        data: {
          name: 'Workspace Secundário CRM',
          slug: `ws-sec-${Date.now()}`,
          organizationId: ws.organizationId,
        },
        include: {
          projects: true,
        },
      });
      project2 = await prisma.project.create({
        data: {
          workspaceId: ws2.id,
          name: 'Projeto CRM Beta',
          key: `PB${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        },
      });
    } else {
      project2 = ws2.projects[0] || (await prisma.project.create({
        data: {
          workspaceId: ws2.id,
          name: 'Projeto CRM Beta',
          key: `PB${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        },
      }));
    }
    workspace2 = ws2;
  });

  describe('4.2-a / T16: Algoritmo Determinístico de Resolução CRM', () => {
    it('deve retornar NOT_FOUND se crmInstanceId for ausente', async () => {
      const result = await resolveCrmContext({ crmInstanceId: '' });
      expect(result.status).toBe('NOT_FOUND');
      expect(result.destination).toBeUndefined();
    });

    it('Precedência 1: deve resolver FOUND quando houver ConversationProjectContext ativo', async () => {
      const conversationId = `conv-${Date.now()}`;
      await prisma.conversationProjectContext.create({
        data: {
          crmInstanceId,
          crmConversationId: conversationId,
          workspaceId: workspace1.id,
          projectId: project1.id,
          active: true,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmConversationId: conversationId,
      });

      expect(result.status).toBe('FOUND');
      expect(result.destination).toBeDefined();
      expect(result.destination?.workspaceId).toBe(workspace1.id);
      expect(result.destination?.projectId).toBe(project1.id);
      expect(result.destination?.resolutionPath).toBe('CONVERSATION_CONTEXT');
    });

    it('Precedência 1: contexto de conversa expirado não deve resolver e deve avançar para contato', async () => {
      const conversationId = `conv-exp-${Date.now()}`;
      const contactId = `contact-exp-${Date.now()}`;

      // Cria contexto de conversa com data no passado (expirado)
      await prisma.conversationProjectContext.create({
        data: {
          crmInstanceId,
          crmConversationId: conversationId,
          workspaceId: workspace1.id,
          projectId: project1.id,
          active: true,
          expiresAt: new Date(Date.now() - 3600000), // expirado há 1 hora
        },
      });

      // Cria vínculo de contato válido no workspace2
      await prisma.workspaceContactLink.create({
        data: {
          crmInstanceId,
          crmContactId: contactId,
          workspaceId: workspace2.id,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmConversationId: conversationId,
        crmContactId: contactId,
      });

      // Como a conversa estava expirada, avançou para contato e achou workspace2
      expect(result.status).toBe('FOUND');
      expect(result.destination?.workspaceId).toBe(workspace2.id);
      expect(result.destination?.resolutionPath).toBe('CONTACT_LINK');
    });

    it('Precedência 2: deve resolver FOUND quando contato possui vínculo único ativo', async () => {
      const contactId = `contact-single-${Date.now()}`;
      await prisma.workspaceContactLink.create({
        data: {
          crmInstanceId,
          crmContactId: contactId,
          workspaceId: workspace1.id,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmContactId: contactId,
      });

      expect(result.status).toBe('FOUND');
      expect(result.destination?.workspaceId).toBe(workspace1.id);
      expect(result.destination?.resolutionPath).toBe('CONTACT_LINK');
    });

    it('Precedência 2 (Invariante DP14): contato vinculado a múltiplos workspaces deve retornar AMBIGUOUS', async () => {
      const contactId = `contact-multi-${Date.now()}`;
      await prisma.workspaceContactLink.createMany({
        data: [
          { crmInstanceId, crmContactId: contactId, workspaceId: workspace1.id },
          { crmInstanceId, crmContactId: contactId, workspaceId: workspace2.id },
        ],
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmContactId: contactId,
      });

      expect(result.status).toBe('AMBIGUOUS');
      expect(result.destination).toBeUndefined();
      expect(result.candidatesCount).toBe(2);
      expect(result.reason).toContain('múltiplos workspaces ativos');
    });

    it('Precedência 3: deve resolver FOUND quando inbox possui rota exclusiva', async () => {
      const inboxId = `inbox-exc-${Date.now()}`;
      await prisma.workspaceInboxRoute.create({
        data: {
          crmInstanceId,
          crmInboxId: inboxId,
          workspaceId: workspace1.id,
          isExclusive: true,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmInboxId: inboxId,
      });

      expect(result.status).toBe('FOUND');
      expect(result.destination?.workspaceId).toBe(workspace1.id);
      expect(result.destination?.resolutionPath).toBe('INBOX_ROUTE');
    });

    it('Precedência 3 (Invariante DP14): inbox compartilhada (não exclusiva) deve retornar AMBIGUOUS', async () => {
      const inboxId = `inbox-shared-${Date.now()}`;
      await prisma.workspaceInboxRoute.create({
        data: {
          crmInstanceId,
          crmInboxId: inboxId,
          workspaceId: workspace1.id,
          isExclusive: false,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId,
        crmInboxId: inboxId,
      });

      expect(result.status).toBe('AMBIGUOUS');
      expect(result.destination).toBeUndefined();
      expect(result.reason).toContain('não é exclusiva');
    });

    it('deve retornar NOT_FOUND quando dados pertencem a outra instância CRM', async () => {
      const contactId = `contact-other-${Date.now()}`;
      await prisma.workspaceContactLink.create({
        data: {
          crmInstanceId,
          crmContactId: contactId,
          workspaceId: workspace1.id,
        },
      });

      const result = await resolveCrmContext({
        crmInstanceId: 'outra-instancia-crm',
        crmContactId: contactId,
      });

      expect(result.status).toBe('NOT_FOUND');
    });
  });

  describe('4.2-b / 4.2-c / T16: TaskCrmLink e Escopo de Atendimento ao Cliente', () => {
    it('deve registrar TaskCrmLink automaticamente ao criar tarefa com contexto CRM', async () => {
      const contactId = `contact-task-${Date.now()}`;
      const conversationId = `conv-task-${Date.now()}`;

      const created = await TaskService.createTask(
        project1.id,
        {
          title: 'Pedido de suporte via WhatsApp',
          crmContext: {
            crmInstanceId,
            crmContactId: contactId,
            crmConversationId: conversationId,
          },
        },
        adminActor
      );

      expect(created.id).toBeDefined();

      const link = await prisma.taskCrmLink.findUnique({
        where: { taskId: created.id },
      });

      expect(link).toBeDefined();
      expect(link?.crmInstanceId).toBe(crmInstanceId);
      expect(link?.crmContactId).toBe(contactId);
      expect(link?.crmConversationId).toBe(conversationId);
    });

    it('listTasksForCustomerAgent deve retornar apenas tarefas daquele contato (isolamento estrito)', async () => {
      const contactA = `contact-A-${Date.now()}`;
      const contactB = `contact-B-${Date.now()}`;

      // Cria 2 tarefas para o contato A
      const taskA1 = await TaskService.createTask(
        project1.id,
        {
          title: 'Chamado A1',
          crmContext: { crmInstanceId, crmContactId: contactA },
        },
        adminActor
      );
      const taskA2 = await TaskService.createTask(
        project1.id,
        {
          title: 'Chamado A2',
          crmContext: { crmInstanceId, crmContactId: contactA },
        },
        adminActor
      );

      // Cria 1 tarefa para o contato B
      const taskB1 = await TaskService.createTask(
        project1.id,
        {
          title: 'Chamado Confidencial B1',
          crmContext: { crmInstanceId, crmContactId: contactB },
        },
        adminActor
      );

      // Agente consultando tarefas do contato A
      const responseA = await TaskService.listTasksForCustomerAgent({
        crmInstanceId,
        crmContactId: contactA,
      });

      expect(responseA.data.length).toBe(2);
      const idsA = responseA.data.map((t) => t.taskId);
      expect(idsA).toContain(taskA1.id);
      expect(idsA).toContain(taskA2.id);
      expect(idsA).not.toContain(taskB1.id);

      // Agente consultando tarefas do contato B
      const responseB = await TaskService.listTasksForCustomerAgent({
        crmInstanceId,
        crmContactId: contactB,
      });

      expect(responseB.data.length).toBe(1);
      expect(responseB.data[0].taskId).toBe(taskB1.id);

      // Validação do DTO de Atendimento: sem vazamento de dados internos (E4.2-c)
      const firstTask = responseA.data[0];
      expect(firstTask.taskId).toBeDefined();
      expect(firstTask.taskNumber).toBeDefined();
      expect(firstTask.title).toBeDefined();
      expect(firstTask.status).toBeDefined();
      expect((firstTask as any).assigneeId).toBeUndefined();
      expect((firstTask as any).assigneeName).toBeUndefined();
      expect((firstTask as any).comments).toBeUndefined();
      expect((firstTask as any).timeEntries).toBeUndefined();
      expect((firstTask as any).estimatedHours).toBeUndefined();
    });

    it('getTaskForCustomerAgent deve bloquear acesso a tarefa pertencente a outro contato', async () => {
      const contactX = `contact-X-${Date.now()}`;
      const contactY = `contact-Y-${Date.now()}`;

      const taskX = await TaskService.createTask(
        project1.id,
        {
          title: 'Projeto Estratégico Cliente X',
          crmContext: { crmInstanceId, crmContactId: contactX },
        },
        adminActor
      );

      // Contato X consegue ver a própria tarefa
      const resX = await TaskService.getTaskForCustomerAgent(taskX.id, {
        crmInstanceId,
        crmContactId: contactX,
      });
      expect(resX.taskId).toBe(taskX.id);
      expect(resX.title).toBe('Projeto Estratégico Cliente X');

      // Contato Y tentando consultar tarefa do Contato X recebe NotFoundError (não vaza existência)
      await expect(
        TaskService.getTaskForCustomerAgent(taskX.id, {
          crmInstanceId,
          crmContactId: contactY,
        })
      ).rejects.toThrow(NotFoundError);
    });
  });
});
