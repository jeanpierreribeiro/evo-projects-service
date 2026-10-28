/**
 * DTOs por finalidade (E1.5-a / Seção 4.1)
 * Garante separação estrita entre persistência, respostas internas e respostas externas.
 */

import { formatCivilDate } from '../utils/dates.js';

export interface TaskInternalDTO {
  id: string;
  taskNumber: number;
  projectKey?: string;
  displayCode?: string;
  version: number;
  workspaceId: string;
  projectId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeAvatar: string | null;
  position: number;
  startDate: string | null;
  dueDate: string | null;
  estimatedMinutes: number | null;
  estimatedHours: number | null;
  tags: string[];
  labels?: Array<{
    id: string;
    name: string;
    normalizedName?: string;
    color: string;
  }>;
  isArchived: boolean;
  column?: {
    id: string;
    name: string;
    color: string | null;
    isDoneColumn: boolean;
  };
  project?: {
    id: string;
    name: string;
    key?: string;
    slug?: string;
    color?: string | null;
    workspaceId?: string;
  };
  subtasks?: Array<{
    id: string;
    taskId: string;
    title: string;
    completed: boolean;
    position: number;
    createdAt: string;
    updatedAt: string;
  }>;
  relationsFrom?: any[];
  relationsTo?: any[];
  relations?: Array<{
    id: string;
    type: 'BLOCKS' | 'BLOCKED_BY' | 'RELATES_TO';
    relatedTask: {
      id: string;
      title: string;
      taskNumber: number;
      displayCode?: string;
      column?: { id: string; name: string; color: string | null; isDoneColumn?: boolean };
    };
    createdAt: string;
  }>;
  resources?: any[];
  timeEntries?: any[];
  comments?: any[];
  fieldValues?: any[];
  completedSubtasks?: number;
  totalSubtasks?: number;
  subtaskProgress?: number;
  _count?: {
    comments?: number;
    subtasks?: number;
    timeEntries?: number;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * TaskPublicDTO (Fase 2 / E2.2): somente dados autorizados para o cliente no compartilhamento
 */
export interface TaskPublicDTO {
  taskId: string;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  checklist?: Array<{ id: string; title: string; completed: boolean }>;
  resources?: Array<{ id: string; title: string; url: string; type: string }>;
  attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; downloadUrl: string }>;
  customFields?: Array<{ name: string; value: string }>;
  publicContentUpdatedAt: string;
}

/**
 * TaskCustomerAgentDTO (Fase 4 / E4.2): dados liberados a bots atendendo clientes
 */
export interface TaskCustomerAgentDTO {
  taskId: string;
  taskNumber: number;
  displayCode?: string;
  title: string;
  status: string;
  dueDate?: string | null;
  publicProgress?: number;
}

/**
 * ShareManagementDTO (Fase 2 / E2.2): gerenciamento de compartilhamentos sem segredos
 */
export interface ShareManagementDTO {
  id: string;
  taskId: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
  createdBy: { type: string; id: string; name?: string };
  sections: {
    showStatus: boolean;
    showPriority: boolean;
    showDates: boolean;
    showChecklist: boolean;
  };
}

/**
 * ShareIssuedDTO (Fase 2 / E2.2): link e PIN devolvidos uma única vez na criação/reemissão
 */
export interface ShareIssuedDTO {
  shareId: string;
  url: string;
  pin: string;
  expiresAt: string;
}

/**
 * Mapeador seguro para TaskInternalDTO usando whitelist estrita de campos permitidos.
 * Garante que segredos legados (approvalToken, approvalPin, etc.) e campos sensíveis
 * nunca sejam incluídos nas respostas.
 */
export function toTaskInternalDTO(task: any): TaskInternalDTO | null {
  if (!task) return null;

  const projectKey = task.project?.key || task.projectKey || 'PROJ';
  const displayCode = task.taskNumber ? `${projectKey}-${task.taskNumber}` : undefined;

  let labels: Array<{ id: string; name: string; normalizedName?: string; color: string }> = [];
  if (Array.isArray(task.labels)) {
    labels = task.labels
      .map((item: any) => {
        if (item.label) {
          return {
            id: item.label.id,
            name: item.label.name,
            normalizedName: item.label.normalizedName,
            color: item.label.color,
          };
        }
        if (item.name) {
          return {
            id: item.id,
            name: item.name,
            normalizedName: item.normalizedName,
            color: item.color || '#64748b',
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  const relations: Array<{
    id: string;
    type: 'BLOCKS' | 'BLOCKED_BY' | 'RELATES_TO';
    relatedTask: {
      id: string;
      title: string;
      taskNumber: number;
      displayCode?: string;
      column?: { id: string; name: string; color: string | null; isDoneColumn?: boolean };
    };
    createdAt: string;
  }> = [];

  if (Array.isArray(task.relationsFrom)) {
    for (const rel of task.relationsFrom) {
      if (rel.relatedTask) {
        relations.push({
          id: rel.id,
          type: rel.type as any,
          relatedTask: {
            id: rel.relatedTask.id,
            title: rel.relatedTask.title,
            taskNumber: rel.relatedTask.taskNumber,
            displayCode: `${projectKey}-${rel.relatedTask.taskNumber}`,
            column: rel.relatedTask.column,
          },
          createdAt: rel.createdAt ? (typeof rel.createdAt === 'string' ? rel.createdAt : rel.createdAt.toISOString()) : '',
        });
      }
    }
  }

  if (Array.isArray(task.relationsTo)) {
    for (const rel of task.relationsTo) {
      if (rel.task) {
        relations.push({
          id: rel.id,
          type: rel.type === 'BLOCKS' ? ('BLOCKED_BY' as any) : (rel.type as any),
          relatedTask: {
            id: rel.task.id,
            title: rel.task.title,
            taskNumber: rel.task.taskNumber,
            displayCode: `${projectKey}-${rel.task.taskNumber}`,
            column: rel.task.column,
          },
          createdAt: rel.createdAt ? (typeof rel.createdAt === 'string' ? rel.createdAt : rel.createdAt.toISOString()) : '',
        });
      }
    }
  }

  return {
    id: task.id,
    taskNumber: task.taskNumber,
    projectKey,
    displayCode,
    version: task.version ?? 1,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    columnId: task.columnId,
    title: task.title,
    description: task.description ?? null,
    priority: String(task.priority),
    assigneeId: task.assigneeId ?? null,
    assigneeName: task.assigneeName ?? null,
    assigneeAvatar: task.assigneeAvatar ?? null,
    position: task.position,
    startDate: formatCivilDate(task.startDate),
    dueDate: formatCivilDate(task.dueDate),
    estimatedMinutes: task.estimatedMinutes ?? (task.estimatedHours != null ? Math.round(task.estimatedHours * 60) : null),
    estimatedHours: task.estimatedMinutes != null ? Number((task.estimatedMinutes / 60).toFixed(2)) : (task.estimatedHours ?? null),
    tags: Array.isArray(task.tags) ? task.tags : [],
    labels,
    isArchived: Boolean(task.isArchived),
    column: task.column
      ? {
          id: task.column.id,
          name: task.column.name,
          color: task.column.color ?? null,
          isDoneColumn: Boolean(task.column.isDoneColumn),
        }
      : undefined,
    project: task.project
      ? {
          id: task.project.id,
          name: task.project.name,
          key: task.project.key,
          slug: task.project.slug,
          color: task.project.color ?? null,
          workspaceId: task.project.workspaceId,
        }
      : undefined,
    subtasks: task.subtasks?.map((s: any) => ({
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      completed: Boolean(s.completed),
      position: s.position,
      createdAt: s.createdAt
        ? typeof s.createdAt === 'string'
          ? s.createdAt
          : s.createdAt.toISOString()
        : '',
      updatedAt: s.updatedAt
        ? typeof s.updatedAt === 'string'
          ? s.updatedAt
          : s.updatedAt.toISOString()
        : '',
    })),
    relationsFrom: task.relationsFrom,
    relationsTo: task.relationsTo,
    relations,
    resources: task.resources,
    timeEntries: task.timeEntries,
    comments: task.comments,
    fieldValues: task.values
      ? task.values.map((v: any) => ({
          fieldId: v.fieldId,
          fieldName: v.field?.name,
          fieldType: v.field?.type,
          value: v.value,
          isPublicEligible: v.field?.isPublicEligible,
        }))
      : task.fieldValues,
    completedSubtasks: task.completedSubtasks,
    totalSubtasks: task.totalSubtasks,
    subtaskProgress: task.subtaskProgress,
    _count: task._count,
    createdAt: task.createdAt
      ? typeof task.createdAt === 'string'
        ? task.createdAt
        : task.createdAt.toISOString()
      : '',
    updatedAt: task.updatedAt
      ? typeof task.updatedAt === 'string'
        ? task.updatedAt
        : task.updatedAt.toISOString()
      : '',
  };
}

export function toTaskInternalListDTO(tasks: any[]): TaskInternalDTO[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.map(toTaskInternalDTO).filter(Boolean) as TaskInternalDTO[];
}

/**
 * Sanitizador de retrocompatibilidade
 */
export function sanitizeTaskDTO<T extends Record<string, any>>(
  task: T | null | undefined
): (Omit<T, 'approvalToken' | 'approvalPin' | 'approvalFeedback' | 'approvedIp'>) | null {
  if (!task) return null;
  const { approvalToken, approvalPin, approvalFeedback, approvedIp, ...safeTask } = task;
  return safeTask as any;
}

export function sanitizeTaskListDTO<T extends Record<string, any>>(
  tasks: (T | null | undefined)[]
): any[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.map(sanitizeTaskDTO).filter(Boolean);
}

export function toTaskCustomerAgentDTO(task: any): TaskCustomerAgentDTO | null {
  if (!task) return null;
  const projectKey = task.project?.key || task.projectKey || 'PROJ';
  const displayCode = task.displayCode || `${projectKey}-${task.taskNumber}`;

  return {
    taskId: task.id,
    taskNumber: task.taskNumber,
    displayCode,
    title: task.title,
    status: task.column?.name || 'Aberto',
    dueDate: formatCivilDate(task.dueDate),
    publicProgress:
      task.subtaskProgress ??
      (task.totalSubtasks && task.totalSubtasks > 0
        ? Math.round(((task.completedSubtasks || 0) / task.totalSubtasks) * 100)
        : undefined),
  };
}

export function toTaskCustomerAgentListDTO(tasks: any[]): TaskCustomerAgentDTO[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.map(toTaskCustomerAgentDTO).filter(Boolean) as TaskCustomerAgentDTO[];
}
