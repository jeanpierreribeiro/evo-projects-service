import prisma from '../db/prisma.js';
import { Priority } from '@prisma/client';
import { ProjectService } from '../services/project.service.js';
import { TaskService } from '../services/task.service.js';
import { ShareService } from '../services/share.service.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { AccessService } from '../services/access.service.js';
import { resolveCrmContext } from '../crm/resolve.js';
import { Actor, ServiceActor } from '../types/auth.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../errors/app-error.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_workspaces',
    description: 'Lista workspaces concedidos ao ator autenticado.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_projects',
    description: 'Lista projetos pertencentes a um workspace específico com contadores e status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'ID do Workspace' },
        includeArchived: { type: 'boolean', description: 'Incluir projetos arquivados' },
      },
      required: ['workspaceId'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Lista tarefas de um projeto (ou tarefas do contato se atendendo cliente externo).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'ID do Projeto (opcional para agente de cliente com contexto CRM)' },
        columnId: { type: 'string', description: 'ID da Coluna' },
        assigneeId: { type: 'string', description: 'ID do Operador responsável' },
        priority: {
          type: 'string',
          enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'],
          description: 'Prioridade da tarefa',
        },
        cursor: { type: 'string', description: 'Cursor de paginação' },
        limit: { type: 'integer', description: 'Limite de registros' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Retorna os detalhes de uma tarefa conforme o perfil do ator.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID da Tarefa' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'create_task',
    description: 'Cria uma nova tarefa em um projeto do jprOS com destino validado e suporte a idempotência.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'ID do Projeto' },
        title: { type: 'string', description: 'Título da tarefa' },
        description: { type: 'string', description: 'Descrição detalhada em Markdown' },
        columnId: { type: 'string', description: 'ID da coluna (opcional, padrão: primeira coluna)' },
        priority: {
          type: 'string',
          enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'],
          description: 'Nível de prioridade',
        },
        assigneeId: { type: 'string', description: 'ID do operador responsável' },
        startDate: { type: 'string', description: 'Data de início ISO (YYYY-MM-DD)' },
        dueDate: { type: 'string', description: 'Data de vencimento ISO (YYYY-MM-DD)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de tags/etiquetas',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Chave de idempotência para retentativa segura sem duplicação',
        },
        dryRun: {
          type: 'boolean',
          description: 'Se true, simula validações sem persistir dados',
        },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'update_task',
    description: 'Atualiza propriedades de uma tarefa existente com controle de concorrência por versão.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID da Tarefa' },
        title: { type: 'string', description: 'Novo título' },
        description: { type: 'string', description: 'Nova descrição Markdown' },
        columnId: { type: 'string', description: 'Novo ID de coluna' },
        priority: {
          type: 'string',
          enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'],
          description: 'Nova prioridade',
        },
        assigneeId: { type: 'string', description: 'Novo ID do responsável' },
        dueDate: { type: 'string', description: 'Nova data de entrega' },
        expectedVersion: { type: 'integer', description: 'Versão esperada da tarefa para controle de concorrência' },
        dryRun: { type: 'boolean', description: 'Se true, valida sem alterar' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'create_task_share',
    description: 'Gera link e PIN de compartilhamento somente leitura para uma tarefa (requer grant canShare).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID da Tarefa' },
        expiresInDays: { type: 'integer', description: 'Dias de validade do link (padrão 14)' },
        showDescription: { type: 'boolean', description: 'Exibir descrição da tarefa' },
        showSubtasks: { type: 'boolean', description: 'Exibir checklist de subtarefas' },
        showResources: { type: 'boolean', description: 'Exibir recursos externos' },
        showAttachments: { type: 'boolean', description: 'Exibir anexos' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'resolve_workspace',
    description: 'Resolve deterministicamente o workspace e projeto a partir do contexto CRM (invariante DP14).',
    inputSchema: {
      type: 'object',
      properties: {
        crmInstanceId: { type: 'string', description: 'ID da Instância CRM' },
        crmContactId: { type: 'string', description: 'ID do Contato no CRM' },
        crmInboxId: { type: 'string', description: 'ID da Inbox/Canal no CRM' },
        crmConversationId: { type: 'string', description: 'ID da Conversa ativa no CRM' },
      },
      required: ['crmInstanceId'],
    },
  },
];

/**
 * Filtra a lista de ferramentas conforme o ator e suas concessões (E4.3-c).
 */
export function filterToolsForActor(tools: McpToolDefinition[], actor?: Actor): McpToolDefinition[] {
  if (!actor) return [];

  if (actor.type === 'service') {
    const sActor = actor as ServiceActor;
    return tools.filter((tool) => {
      // 1. Se houver allowedTools explícito, restringe a ele
      if (sActor.allowedTools && sActor.allowedTools.length > 0) {
        if (!sActor.allowedTools.includes(tool.name)) return false;
      }

      // 2. create_task_share exige canShare = true
      if (tool.name === 'create_task_share' && !sActor.canShare) {
        return false;
      }

      // 3. Agente de atendimento ao cliente não pode atualizar tarefas
      if (tool.name === 'update_task' && sActor.mode === 'customer_agent') {
        return false;
      }

      return true;
    });
  }

  return tools;
}

/**
 * Executa uma ferramenta MCP com validações estritas de escopo e política (E4.3-c / E4.4).
 */
export async function executeMcpTool(name: string, args: Record<string, any>, actor?: Actor) {
  if (!actor || !actor.id) {
    throw new ValidationError('Ator autenticado é obrigatório para execução de ferramenta MCP.');
  }

  // Validação de escopo do ServicePrincipal (E4.3-b / E4.4-a)
  if (actor.type === 'service') {
    const sActor = actor as ServiceActor;
    if (sActor.allowedTools && sActor.allowedTools.length > 0 && !sActor.allowedTools.includes(name)) {
      throw new ForbiddenError(`Ferramenta MCP "${name}" não autorizada para este ServicePrincipal.`);
    }
    if (name === 'create_task_share' && !sActor.canShare) {
      throw new ForbiddenError('A credencial de serviço não possui grant com permissão canShare.');
    }
    if (name === 'update_task' && sActor.mode === 'customer_agent') {
      throw new ForbiddenError('Agentes de atendimento ao cliente não têm permissão para atualizar tarefas.');
    }
  }

  switch (name) {
    case 'resolve_workspace': {
      const result = await resolveCrmContext({
        crmInstanceId: args.crmInstanceId,
        crmContactId: args.crmContactId,
        crmInboxId: args.crmInboxId,
        crmConversationId: args.crmConversationId,
      });
      return result;
    }

    case 'list_workspaces': {
      if (actor.type === 'service') {
        const sActor = actor as ServiceActor;
        const allowed = sActor.allowedWorkspaces || [];
        const workspaces = await prisma.workspace.findMany({
          where: {
            id: { in: allowed },
            isArchived: false,
            deletedAt: null,
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, slug: true, isArchived: true },
        });
        return { workspaces };
      }

      const workspaces = await prisma.workspace.findMany({
        where: {
          members: {
            some: { userId: actor.id, status: 'ACTIVE' },
          },
          isArchived: false,
          deletedAt: null,
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true, isArchived: true },
      });
      return { workspaces };
    }

    case 'list_projects': {
      if (!args.workspaceId) throw new ValidationError('workspaceId é obrigatório.');
      const projects = await ProjectService.listByWorkspace(args.workspaceId, actor, args.includeArchived);
      return { projects };
    }

    case 'list_tasks': {
      // Modo atendimento a cliente: escopo estrito via TaskCrmLink (E4.2-b / E4.4-a)
      if (actor.type === 'service' && (actor as ServiceActor).mode === 'customer_agent') {
        const sActor = actor as ServiceActor;
        const crmContext = sActor.crmContext;
        if (!crmContext?.crmInstanceId) {
          throw new ValidationError('Contexto CRM ausente no transporte para agente de atendimento.');
        }

        const result = await TaskService.listTasksForCustomerAgent({
          crmInstanceId: crmContext.crmInstanceId,
          crmContactId: crmContext.crmContactId,
          crmConversationId: crmContext.crmConversationId,
          cursor: args.cursor,
          limit: args.limit,
        });

        return { tasks: result.data, pagination: result.pagination };
      }

      if (!args.projectId) {
        throw new ValidationError('projectId é obrigatório para listagem de tarefas de operadores/automação.');
      }

      const result = await TaskService.listByProject(args.projectId, actor, {
        columnId: args.columnId,
        assigneeId: args.assigneeId,
        priority: args.priority as Priority,
        cursor: args.cursor,
        limit: args.limit,
      });
      return { tasks: result.data, pagination: result.pagination };
    }

    case 'get_task': {
      if (!args.taskId) throw new ValidationError('taskId é obrigatório.');

      // Modo atendimento a cliente: consulta restrita sem metadados internos (E4.2-b / E4.2-c)
      if (actor.type === 'service' && (actor as ServiceActor).mode === 'customer_agent') {
        const sActor = actor as ServiceActor;
        const crmContext = sActor.crmContext;
        if (!crmContext?.crmInstanceId) {
          throw new ValidationError('Contexto CRM ausente no transporte.');
        }

        const task = await TaskService.getTaskForCustomerAgent(args.taskId, {
          crmInstanceId: crmContext.crmInstanceId,
          crmContactId: crmContext.crmContactId,
          crmConversationId: crmContext.crmConversationId,
        });

        return { task };
      }

      const task = await TaskService.getTask(args.taskId, actor);
      if (!task) throw new NotFoundError(`Tarefa ${args.taskId} não encontrada.`);
      return { task };
    }

    case 'create_task': {
      if (!args.projectId) throw new ValidationError('projectId é obrigatório.');
      if (!args.title?.trim()) throw new ValidationError('title é obrigatório.');

      if (args.dryRun) {
        await AccessService.getAuthorizedProject(args.projectId, actor, 'create_task');
        return { dryRun: true, valid: true };
      }

      const sActor = actor.type === 'service' ? (actor as ServiceActor) : null;
      const crmContext = sActor?.mode === 'customer_agent' ? sActor.crmContext : undefined;

      const taskData = {
        title: args.title.trim(),
        description: args.description,
        columnId: args.columnId,
        priority: args.priority as Priority,
        assigneeId: args.assigneeId,
        startDate: args.startDate,
        dueDate: args.dueDate,
        tags: args.tags,
        crmContext: crmContext
          ? {
              crmInstanceId: crmContext.crmInstanceId,
              crmContactId: crmContext.crmContactId,
              crmConversationId: crmContext.crmConversationId,
            }
          : undefined,
      };

      if (args.idempotencyKey) {
        const project = await AccessService.getAuthorizedProject(args.projectId, actor, 'create_task');
        const scopeKey = IdempotencyService.buildScopeKey(
          actor.id,
          project.workspaceId,
          'create_task',
          args.idempotencyKey
        );

        const res = await IdempotencyService.runIdempotent(scopeKey, taskData, async () => {
          const created = await TaskService.createTask(args.projectId, taskData, actor);
          return { statusCode: 201, result: { task: created } };
        });

        return res.result;
      }

      const task = await TaskService.createTask(args.projectId, taskData, actor);
      return { task };
    }

    case 'update_task': {
      if (!args.taskId) throw new ValidationError('taskId é obrigatório.');

      if (args.dryRun) {
        await AccessService.getAuthorizedTask(args.taskId, actor, 'write_task');
        return { dryRun: true, valid: true };
      }

      const task = await TaskService.updateTask(
        args.taskId,
        {
          title: args.title,
          description: args.description,
          columnId: args.columnId,
          priority: args.priority as Priority,
          assigneeId: args.assigneeId,
          dueDate: args.dueDate,
          expectedVersion: args.expectedVersion,
        },
        actor
      );
      return { task };
    }

    case 'create_task_share': {
      if (!args.taskId) throw new ValidationError('taskId é obrigatório.');

      const share = await ShareService.createShare(actor, args.taskId, {
        expiresInDays: args.expiresInDays,
        showDescription: args.showDescription,
        showSubtasks: args.showSubtasks,
        showResources: args.showResources,
        showAttachments: args.showAttachments,
      });

      const sActor = actor.type === 'service' ? (actor as ServiceActor) : null;
      const isCustomerAgent = sActor?.mode === 'customer_agent';

      return {
        shareId: share.shareId,
        taskId: args.taskId,
        url: share.url,
        pin: share.pin,
        expiresAt: share.expiresAt,
        deliveryPolicy: isCustomerAgent
          ? 'Link e PIN devem ser enviados ao cliente em mensagens separadas (E4.4-c).'
          : undefined,
      };
    }

    default:
      throw new ValidationError(`Ferramenta MCP desconhecida ou não suportada: "${name}"`);
  }
}
