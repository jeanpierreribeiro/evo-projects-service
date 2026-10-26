import prisma from '../db/prisma.js';
import { Priority } from '@prisma/client';
import { WorkspaceService } from '../services/workspace.service.js';
import { ProjectService } from '../services/project.service.js';
import { TaskService } from '../services/task.service.js';
import { ApprovalService } from '../services/approval.service.js';

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
    description: 'Lista todos os workspaces (empresas/clientes) disponíveis no jprOS.',
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
    description: 'Lista tarefas de um projeto com filtros opcionais por coluna, responsável e prioridade.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'ID do Projeto' },
        columnId: { type: 'string', description: 'ID da Coluna' },
        assigneeId: { type: 'string', description: 'ID do Operador responsável' },
        priority: {
          type: 'string',
          enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'],
          description: 'Prioridade da tarefa',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_task',
    description: 'Retorna os detalhes completos de uma tarefa (título, descrição markdown, subtarefas, relações, anexos e status de aprovação).',
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
    description: 'Cria uma nova tarefa em um projeto do jprOS.',
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
        startDate: { type: 'string', description: 'Data de início ISO (YYYY-MM-DD ou ISO8601)' },
        dueDate: { type: 'string', description: 'Data de vencimento ISO (YYYY-MM-DD ou ISO8601)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de tags/etiquetas',
        },
      },
      required: ['projectId', 'title'],
    },
  },
  {
    name: 'update_task',
    description: 'Atualiza propriedades de uma tarefa existente (título, descrição, coluna, prioridade, responsável ou datas).',
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
      },
      required: ['taskId'],
    },
  },
  {
    name: 'request_task_approval',
    description: 'Gera um link seguro com Token único e código PIN de 4 dígitos para envio direto ao cliente no WhatsApp validar e aprovar a entrega.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID da Tarefa' },
      },
      required: ['taskId'],
    },
  },
];

export async function executeMcpTool(name: string, args: Record<string, any>, actor?: { id: string; name: string }) {
  const defaultActor = actor || { id: 'ai-agent', name: 'Assistente IA (jprOS)' };

  switch (name) {
    case 'list_workspaces': {
      const workspaces = await prisma.workspace.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { projects: true, tasks: true, members: true } },
        },
      });
      return { workspaces };
    }

    case 'list_projects': {
      const projects = await ProjectService.listByWorkspace(args.workspaceId, args.includeArchived);
      return { projects };
    }

    case 'list_tasks': {
      const tasks = await TaskService.listByProject(args.projectId, {
        columnId: args.columnId,
        assigneeId: args.assigneeId,
        priority: args.priority as Priority,
      });
      return { tasks };
    }

    case 'get_task': {
      const task = await TaskService.getTask(args.taskId);
      if (!task) throw new Error(`Tarefa ${args.taskId} não encontrada.`);
      return { task };
    }

    case 'create_task': {
      const task = await TaskService.createTask(
        args.projectId,
        {
          title: args.title,
          description: args.description,
          columnId: args.columnId,
          priority: args.priority as Priority,
          assigneeId: args.assigneeId,
          startDate: args.startDate,
          dueDate: args.dueDate,
          tags: args.tags,
        },
        defaultActor
      );
      return { task };
    }

    case 'update_task': {
      const task = await TaskService.updateTask(
        args.taskId,
        {
          title: args.title,
          description: args.description,
          columnId: args.columnId,
          priority: args.priority as Priority,
          assigneeId: args.assigneeId,
          dueDate: args.dueDate,
        },
        defaultActor
      );
      return { task };
    }

    case 'request_task_approval': {
      const approval = await ApprovalService.generateLink(args.taskId, defaultActor);
      return {
        ...approval,
        instructions: `Envie o seguinte link ao cliente: /p/task/${approval.approvalToken}?pin=${approval.approvalPin} ou informe o código PIN ${approval.approvalPin} para validação.`,
      };
    }

    default:
      throw new Error(`Ferramenta MCP desconhecida: "${name}"`);
  }
}
