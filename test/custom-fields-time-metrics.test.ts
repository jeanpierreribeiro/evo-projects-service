import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../src/db/prisma.js';
import { CustomFieldService } from '../src/services/custom-field.service.js';
import { TaskService } from '../src/services/task.service.js';
import { ProjectService } from '../src/services/project.service.js';
import { ShareService } from '../src/services/share.service.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { Actor } from '../src/types/auth.js';
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../src/errors/app-error.js';
import { generateShareToken, hashToken, hashPin } from '../src/share/crypto.js';
import { buildPublicCard } from '../src/share/public-card.js';
import { createTestJwt } from './helpers/auth.js';
import { AuthClient } from '../src/auth/auth-client.js';

// Mock do AuthClient para requisições autenticadas via app.inject()
vi.mock('../src/auth/auth-client.js', () => ({
  AuthClient: {
    validateToken: vi.fn(),
  },
  AuthServiceUnavailableError: class extends Error {},
}));

describe('E3.8, T04, T10, T13 & T14 - Campos Personalizados, Apontamentos e Indicadores', () => {
  const app = buildApp();

  let workspaceId: string;
  let projectAId: string;
  let projectBId: string;
  let taskAId: string;
  let taskBId: string;

  let adminUserId: string;
  let member1UserId: string;
  let member2UserId: string;

  let adminActor: Actor;
  let member1Actor: Actor;
  let member2Actor: Actor;

  let adminJwt: string;
  let member1Jwt: string;
  let member2Jwt: string;

  beforeEach(async () => {
    config.projectsSharingEnabled = true;

    const ws = await prisma.workspace.findUnique({
      where: { slug: 'operacao-principal' },
      include: {
        members: true,
        projects: {
          orderBy: { createdAt: 'asc' },
          include: {
            columns: { orderBy: { position: 'asc' } },
          },
        },
      },
    });

    if (!ws || ws.projects.length < 1) {
      throw new Error('Workspace ou projeto seed não encontrado.');
    }

    workspaceId = ws.id;
    const mainProj = ws.projects[0];
    projectAId = mainProj.id;

    // Garante que exista um segundo projeto ativo no workspace para testes de isolamento de campos
    let projB = ws.projects.find((p) => p.id !== projectAId && !p.deletedAt && !p.isArchived);
    if (!projB) {
      projB = await prisma.project.create({
        data: {
          workspaceId: ws.id,
          name: 'Projeto Beta Custom Fields',
          slug: `proj-beta-cf-${Date.now()}`,
          key: `BETA${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
          columns: {
            create: [
              { name: 'A Fazer', position: 0, isDoneColumn: false },
              { name: 'Concluído', position: 1, isDoneColumn: true },
            ],
          },
        },
        include: { columns: true },
      });
    }
    projectBId = projB.id;

    const admin = ws.members.find((m) => m.role === 'ADMIN' && m.status === 'ACTIVE');
    if (!admin) throw new Error('Admin ativo não encontrado.');
    adminUserId = admin.userId;

    // Membro 1
    const m1 = await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: ws.id,
          userId: 'test-user-m1-cf',
        },
      },
      create: {
        workspaceId: ws.id,
        userId: 'test-user-m1-cf',
        email: 'm1-cf@jpros.local',
        name: 'Membro Um CF',
        role: 'MEMBER',
        status: 'ACTIVE',
      },
      update: { role: 'MEMBER', status: 'ACTIVE' },
    });
    member1UserId = m1.userId;

    // Membro 2
    const m2 = await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: ws.id,
          userId: 'test-user-m2-cf',
        },
      },
      create: {
        workspaceId: ws.id,
        userId: 'test-user-m2-cf',
        email: 'm2-cf@jpros.local',
        name: 'Membro Dois CF',
        role: 'MEMBER',
        status: 'ACTIVE',
      },
      update: { role: 'MEMBER', status: 'ACTIVE' },
    });
    member2UserId = m2.userId;

    adminActor = { type: 'user', id: adminUserId, email: admin.email, name: admin.name };
    member1Actor = { type: 'user', id: member1UserId, email: m1.email, name: m1.name };
    member2Actor = { type: 'user', id: member2UserId, email: m2.email, name: m2.name };

    adminJwt = await createTestJwt({ sub: adminUserId, email: admin.email, name: admin.name, role: 'ADMIN' });
    member1Jwt = await createTestJwt({ sub: member1UserId, email: m1.email, name: m1.name, role: 'MEMBER' });
    member2Jwt = await createTestJwt({ sub: member2UserId, email: m2.email, name: m2.name, role: 'MEMBER' });

    // Garante tarefas ativas em cada projeto
    const colA = mainProj.columns[0];
    const taskA = await prisma.task.create({
      data: {
        workspaceId: ws.id,
        projectId: projectAId,
        columnId: colA.id,
        title: 'Tarefa A Teste E3.8',
        taskNumber: Math.floor(Math.random() * 80000) + 10000,
      },
    });
    taskAId = taskA.id;

    const colB = projB.columns[0];
    const taskB = await prisma.task.create({
      data: {
        workspaceId: ws.id,
        projectId: projectBId,
        columnId: colB.id,
        title: 'Tarefa B Teste E3.8',
        taskNumber: Math.floor(Math.random() * 80000) + 10000,
      },
    });
    taskBId = taskB.id;

    vi.mocked(AuthClient.validateToken).mockImplementation(async (token: string) => {
      if (token === adminJwt) {
        return { valid: true, user: { id: adminUserId, email: admin.email, name: admin.name, role: 'ADMIN' } };
      }
      if (token === member1Jwt) {
        return { valid: true, user: { id: member1UserId, email: m1.email, name: m1.name, role: 'MEMBER' } };
      }
      return { valid: true, user: { id: member2UserId, email: m2.email, name: m2.name, role: 'MEMBER' } };
    });
  });

  describe('1. Campos Personalizados (CustomFieldService - E3.8-a / T13 / T14)', () => {
    let textFieldId: string;
    let numberFieldId: string;
    let dateFieldId: string;
    let selectFieldId: string;
    let selectOption1Id: string;
    let selectOption2Id: string;

    it('ADMIN deve criar campos de todos os tipos válidos e gerar opções com identidade estável', async () => {
      // 1. Texto
      const textField = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Observação Técnica',
        type: 'text',
        isPublicEligible: false,
        actor: adminActor,
      });
      expect(textField.id).toBeDefined();
      expect(textField.type).toBe('text');
      textFieldId = textField.id;

      // 2. Número
      const numberField = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Pontos de História',
        type: 'number',
        isPublicEligible: true, // elegível para cliente
        actor: adminActor,
      });
      expect(numberField.id).toBeDefined();
      expect(numberField.type).toBe('number');
      expect(numberField.isPublicEligible).toBe(true);
      numberFieldId = numberField.id;

      // 3. Data civil
      const dateField = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Previsão de Entrega',
        type: 'date',
        isPublicEligible: true,
        actor: adminActor,
      });
      expect(dateField.id).toBeDefined();
      expect(dateField.type).toBe('date');
      dateFieldId = dateField.id;

      // 4. Seleção (Select com opções estruturadas estáveis)
      const selectField = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Fase do Projeto',
        type: 'select',
        options: [
          { label: 'Planejamento', color: '#3b82f6' },
          { label: 'Execução', color: '#10b981' },
        ],
        isPublicEligible: true,
        actor: adminActor,
      });
      expect(selectField.id).toBeDefined();
      expect(selectField.type).toBe('select');
      expect(selectField.options).toHaveLength(2);
      expect(selectField.options[0].id).toBeDefined();
      expect(selectField.options[0].label).toBe('Planejamento');

      selectFieldId = selectField.id;
      selectOption1Id = selectField.options[0].id;
      selectOption2Id = selectField.options[1].id;
    });

    it('MEMBER comum não pode criar, editar ou excluir definição de campo (403 Forbidden)', async () => {
      await expect(
        CustomFieldService.createCustomField({
          projectId: projectAId,
          name: 'Tentativa Ilegal',
          type: 'text',
          actor: member1Actor,
        })
      ).rejects.toThrow(ForbiddenError);

      await expect(
        CustomFieldService.updateCustomField({
          fieldId: textFieldId,
          name: 'Novo Nome Ilegal',
          actor: member1Actor,
        })
      ).rejects.toThrow(ForbiddenError);

      await expect(
        CustomFieldService.deleteCustomField(textFieldId, member1Actor)
      ).rejects.toThrow(ForbiddenError);
    });

    it('deve atribuir e validar valores estritamente por tipo (text, number, date, select)', async () => {
      // Texto válido
      const textVal = await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: textFieldId,
        value: 'Este é um texto válido de especificação.',
        actor: member1Actor,
      });
      expect(textVal.value).toBe('Este é um texto válido de especificação.');

      // Número válido e rejeição de número inválido
      const numVal = await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: numberFieldId,
        value: 42,
        actor: member1Actor,
      });
      expect(numVal.value).toBe('42');

      await expect(
        CustomFieldService.setTaskCustomFieldValue({
          taskId: taskAId,
          fieldId: numberFieldId,
          value: 'não é número',
          actor: member1Actor,
        })
      ).rejects.toThrow(ValidationError);

      // Data civil válida e rejeição de data fictícia
      const dateVal = await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: dateFieldId,
        value: '2026-11-15',
        actor: member1Actor,
      });
      expect(dateVal.value).toBe('2026-11-15');

      await expect(
        CustomFieldService.setTaskCustomFieldValue({
          taskId: taskAId,
          fieldId: dateFieldId,
          value: '2026-02-30', // inexistente no calendário civil
          actor: member1Actor,
        })
      ).rejects.toThrow(ValidationError);

      // Select válido por ID ou label e rejeição de opção não existente
      const selectVal = await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: selectFieldId,
        value: selectOption1Id,
        actor: member1Actor,
      });
      expect(selectVal.value).toBe(selectOption1Id);
      expect(selectVal.displayValue).toBe('Planejamento');

      await expect(
        CustomFieldService.setTaskCustomFieldValue({
          taskId: taskAId,
          fieldId: selectFieldId,
          value: 'Opção Inexistente',
          actor: member1Actor,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('Invariante I8: campo do Projeto B não pode ser associado a tarefa do Projeto A (ValidationError)', async () => {
      const fieldProjB = await CustomFieldService.createCustomField({
        projectId: projectBId,
        name: 'Campo do Projeto B',
        type: 'text',
        actor: adminActor,
      });

      await expect(
        CustomFieldService.setTaskCustomFieldValue({
          taskId: taskAId, // Tarefa do Projeto A
          fieldId: fieldProjB.id, // Campo do Projeto B!
          value: 'Tentativa cruzada',
          actor: member1Actor,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('Tratamento de opções em uso: tentar remover opção associada a tarefas ativas lança ConflictError', async () => {
      // Associa a opção 1 à taskAId
      await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: selectFieldId,
        value: selectOption1Id,
        actor: member1Actor,
      });

      // Tentar remover a opção 1 em uso deve lançar ConflictError
      await expect(
        CustomFieldService.updateCustomField({
          fieldId: selectFieldId,
          options: [
            // Mantém apenas a opção 2, tentando remover a opção 1 que está em uso!
            { id: selectOption2Id, label: 'Execução' },
          ],
          actor: adminActor,
        })
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('2. Apontamentos de Horas (TimeEntry - E3.8-c / T04 / T13)', () => {
    let m1EntryId: string;

    it('deve criar apontamento com minutos positivos e data civil, incrementando versão da tarefa', async () => {
      const initialTask = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });

      const entry = await TaskService.addTimeEntry(
        taskAId,
        {
          durationMinutes: 120, // 2 horas
          date: '2026-10-27',
          description: 'Desenvolvimento do backend de campos personalizados',
        },
        member1Actor
      );

      expect(entry.id).toBeDefined();
      expect(entry.durationMinutes).toBe(120);
      expect(entry.userId).toBe(member1UserId);
      m1EntryId = entry.id;

      // Incremento de versão da tarefa verificado
      const afterTask = await prisma.task.findUniqueOrThrow({ where: { id: taskAId } });
      expect(afterTask.version).toBeGreaterThan(initialTask.version);

      // Rejeição de minutos zero ou negativos
      await expect(
        TaskService.addTimeEntry(
          taskAId,
          { durationMinutes: 0, description: 'Inválido' },
          member1Actor
        )
      ).rejects.toThrow(ValidationError);
    });

    it('Regra de Autoria T04: autor pode editar/excluir; outro membro é barrado (403); ADMIN tem permissão total', async () => {
      // Cria apontamento pelo Membro 1 para o cenário de autoria
      const entry = await TaskService.addTimeEntry(
        taskAId,
        {
          durationMinutes: 120,
          date: '2026-10-27',
          description: 'Original por Membro 1',
        },
        member1Actor
      );
      const entryId = entry.id;

      // 1. Membro 2 tenta editar apontamento do Membro 1 -> 403 Forbidden
      await expect(
        TaskService.updateTimeEntry(
          entryId,
          { durationMinutes: 180, description: 'Alteração Ilegal' },
          member2Actor
        )
      ).rejects.toThrow(ForbiddenError);

      // 2. Membro 2 tenta excluir apontamento do Membro 1 -> 403 Forbidden
      await expect(
        TaskService.removeTimeEntry(entryId, member2Actor)
      ).rejects.toThrow(ForbiddenError);

      // 3. Membro 1 (autor) edita com sucesso
      const updatedByAuthor = await TaskService.updateTimeEntry(
        entryId,
        { durationMinutes: 150, description: 'Refatoração concluída' },
        member1Actor
      );
      expect(updatedByAuthor.durationMinutes).toBe(150);

      // 4. ADMIN edita com sucesso (governança do workspace)
      const updatedByAdmin = await TaskService.updateTimeEntry(
        entryId,
        { description: 'Revisado pelo Admin' },
        adminActor
      );
      expect(updatedByAdmin.description).toBe('Revisado pelo Admin');

      // 5. Listagem de apontamentos calcula total de minutos e horas
      const list = await TaskService.listTimeEntries(taskAId, member1Actor);
      expect(list.entries.length).toBeGreaterThanOrEqual(1);
      expect(list.totalMinutes).toBe(150);
      expect(list.totalHours).toBe(2.5);

      // Exclusão pelo ADMIN
      await TaskService.removeTimeEntry(entryId, adminActor);
      const afterDel = await prisma.timeEntry.findUnique({ where: { id: entryId } });
      expect(afterDel).toBeNull();
    });
  });

  describe('3. Compartilhamento Público e Elegibilidade de Campos (3.8-a & T10)', () => {
    let eligibleFieldId: string;
    let internalFieldId: string;

    beforeEach(async () => {
      // Campo elegível para cliente
      const f1 = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Versão da Entrega',
        type: 'text',
        isPublicEligible: true,
        actor: adminActor,
      });
      eligibleFieldId = f1.id;

      // Campo interno confidencial
      const f2 = await CustomFieldService.createCustomField({
        projectId: projectAId,
        name: 'Custo Interno Estimado',
        type: 'number',
        isPublicEligible: false,
        actor: adminActor,
      });
      internalFieldId = f2.id;

      // Atribui valores à tarefa
      await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: eligibleFieldId,
        value: 'v2.1-release',
        actor: adminActor,
      });
      await CustomFieldService.setTaskCustomFieldValue({
        taskId: taskAId,
        fieldId: internalFieldId,
        value: 5000,
        actor: adminActor,
      });
    });

    it('deve rejeitar inclusão de campo interno (não elegível) na seleção do share (ValidationError)', async () => {
      await expect(
        ShareService.createShare(adminActor, taskAId, {
          selectedCustomFieldIds: [internalFieldId], // NÃO elegível!
        })
      ).rejects.toThrow(ValidationError);
    });

    it('buildPublicCard deve incluir estritamente campos elegíveis e explicitamente selecionados', async () => {
      const fullTask = await prisma.task.findUniqueOrThrow({
        where: { id: taskAId },
        include: {
          column: true,
          fieldValues: { include: { field: true } },
        },
      });

      // Caso 1: Campo elegível selecionado -> Exibido no card
      const cardWithField = buildPublicCard(fullTask, {
        showCustomFields: true,
        selectedCustomFieldIds: [eligibleFieldId],
      });
      expect(cardWithField.customFields).toBeDefined();
      expect(cardWithField.customFields).toHaveLength(1);
      expect(cardWithField.customFields![0].name).toBe('Versão da Entrega');
      expect(cardWithField.customFields![0].value).toBe('v2.1-release');

      // Caso 2: Campo elegível NÃO selecionado no share -> Oculto no card
      const cardWithoutSelection = buildPublicCard(fullTask, {
        showCustomFields: true,
        selectedCustomFieldIds: [], // Nenhum selecionado
      });
      expect(cardWithoutSelection.customFields).toHaveLength(0);

      // Caso 3: showCustomFields === false -> Oculta todos
      const cardDisabled = buildPublicCard(fullTask, {
        showCustomFields: false,
        selectedCustomFieldIds: [eligibleFieldId],
      });
      expect(cardDisabled.customFields).toBeUndefined();
    });
  });

  describe('4. Indicadores e Métricas Operacionais (E3.8-d & Seção 6.6)', () => {
    it('Progresso do projeto deve calcular tarefas concluídas / ativas e excluir arquivadas e excluídas', async () => {
      // Cria projeto exclusivo para teste de métricas
      const metricProj = await prisma.project.create({
        data: {
          workspaceId,
          name: 'Projeto Métricas Exclusivo',
          slug: `proj-metrics-${Date.now()}`,
          key: `METR${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          columns: {
            create: [
              { name: 'A Fazer', position: 0, isDoneColumn: false },
              { name: 'Concluído', position: 1, isDoneColumn: true },
            ],
          },
        },
        include: { columns: true },
      });

      const colTodo = metricProj.columns.find((c) => !c.isDoneColumn)!;
      const colDone = metricProj.columns.find((c) => c.isDoneColumn)!;

      // 1 Tarefa ativa aberta
      await prisma.task.create({
        data: {
          workspaceId,
          projectId: metricProj.id,
          columnId: colTodo.id,
          title: 'Tarefa Aberta',
          taskNumber: 1,
        },
      });

      // 1 Tarefa ativa concluída
      await prisma.task.create({
        data: {
          workspaceId,
          projectId: metricProj.id,
          columnId: colDone.id,
          title: 'Tarefa Concluída',
          taskNumber: 2,
        },
      });

      // 1 Tarefa arquivada (não pode entrar na conta de total nem concluída!)
      await prisma.task.create({
        data: {
          workspaceId,
          projectId: metricProj.id,
          columnId: colDone.id,
          title: 'Tarefa Arquivada',
          isArchived: true,
          taskNumber: 3,
        },
      });

      // 1 Tarefa com exclusão lógica (não pode entrar na conta!)
      await prisma.task.create({
        data: {
          workspaceId,
          projectId: metricProj.id,
          columnId: colDone.id,
          title: 'Tarefa Excluída',
          deletedAt: new Date(),
          taskNumber: 4,
        },
      });

      const result = await ProjectService.listByWorkspace(workspaceId, adminActor);
      const projData = result.data.find((p: any) => p.id === metricProj.id);

      expect(projData).toBeDefined();
      // Total de ativas = 2 (1 aberta + 1 concluída)
      expect(projData.totalTasks).toBe(2);
      expect(projData.completedTasks).toBe(1);
      // Progresso = 1 / 2 = 50%
      expect(projData.progress).toBe(50);
    });

    it('GET /workspaces/:workspaceId/dashboard deve ordenar próximas tarefas e separar tarefas sem prazo', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/workspaces/${workspaceId}/dashboard`,
        headers: {
          authorization: `Bearer ${adminJwt}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);

      expect(json.data.stats).toBeDefined();
      expect(json.data.stats.totalTasks).toBeGreaterThanOrEqual(1);
      expect(json.data.upcomingTasks).toBeDefined();
      expect(json.data.tasksWithoutDueDate).toBeDefined();
    });
  });
});
