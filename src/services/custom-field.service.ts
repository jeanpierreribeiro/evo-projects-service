import crypto from 'crypto';
import prisma from '../db/prisma.js';
import { AccessService } from './access.service.js';
import { ActivityService } from './activity.service.js';
import { TaskService } from './task.service.js';
import { Actor } from '../types/auth.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors/app-error.js';
import { parseCivilDate } from '../utils/dates.js';

export type CustomFieldType = 'text' | 'number' | 'select' | 'date';

export interface CustomFieldOption {
  id: string;
  label: string;
  color?: string | null;
}

export interface CustomFieldDTO {
  id: string;
  projectId: string;
  name: string;
  type: CustomFieldType;
  options: CustomFieldOption[];
  isPublicEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCustomFieldValueDTO {
  fieldId: string;
  fieldName: string;
  fieldType: CustomFieldType;
  value: string | null;
  displayValue: string | null;
  isPublicEligible: boolean;
}

export class CustomFieldService {
  /**
   * Valida e normaliza opções de campos do tipo 'select'.
   * Garante identidade estável para cada opção.
   */
  static normalizeOptions(rawOptions: any[] | null | undefined): CustomFieldOption[] {
    if (!Array.isArray(rawOptions)) return [];

    return rawOptions.map((opt, idx) => {
      if (typeof opt === 'string') {
        const trimmed = opt.trim();
        if (!trimmed) {
          throw new ValidationError(`Opção no índice ${idx} não pode ser vazia.`);
        }
        return {
          id: `opt_${crypto.randomBytes(4).toString('hex')}`,
          label: trimmed,
          color: null,
        };
      }

      if (typeof opt === 'object' && opt !== null) {
        const label = String(opt.label || opt.name || '').trim();
        if (!label) {
          throw new ValidationError(`Opção no índice ${idx} deve possuir um label válido.`);
        }
        return {
          id: String(opt.id || `opt_${crypto.randomBytes(4).toString('hex')}`),
          label,
          color: opt.color ? String(opt.color).trim() : null,
        };
      }

      throw new ValidationError(`Formato de opção inválido no índice ${idx}.`);
    });
  }

  /**
   * Valida o valor contra a definição e tipo do campo.
   */
  static validateFieldValue(
    field: { type: string; options: any },
    rawValue: any
  ): { storedValue: string | null; displayValue: string | null } {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return { storedValue: null, displayValue: null };
    }

    const type = field.type as CustomFieldType;

    switch (type) {
      case 'text': {
        const str = String(rawValue).trim();
        if (str.length > 5000) {
          throw new ValidationError('Texto do campo personalizado excede o limite de 5.000 caracteres.');
        }
        return { storedValue: str, displayValue: str };
      }

      case 'number': {
        const num = Number(rawValue);
        if (isNaN(num) || !isFinite(num)) {
          throw new ValidationError(`Valor "${rawValue}" não é um número válido para este campo.`);
        }
        return { storedValue: String(num), displayValue: String(num) };
      }

      case 'date': {
        const str = String(rawValue).trim();
        // Valida calendário civil estrito no formato YYYY-MM-DD
        parseCivilDate(str);
        return { storedValue: str, displayValue: str };
      }

      case 'select': {
        const str = String(rawValue).trim();
        const options: CustomFieldOption[] = Array.isArray(field.options) ? field.options : [];
        // Permite match tanto por option.id quanto por option.label
        const matched = options.find((o) => o.id === str || o.label.toLowerCase() === str.toLowerCase());
        if (!matched) {
          throw new ValidationError(
            `Opção "${str}" não é válida para este campo de seleção.`
          );
        }
        return { storedValue: matched.id, displayValue: matched.label };
      }

      default:
        throw new ValidationError(`Tipo de campo não suportado: ${type}`);
    }
  }

  /**
   * Cria novo campo personalizado para um projeto (E3.8-a / ADMIN).
   */
  static async createCustomField(params: {
    projectId: string;
    name: string;
    type: CustomFieldType;
    options?: any[];
    isPublicEligible?: boolean;
    actor: Actor;
  }): Promise<CustomFieldDTO> {
    const { projectId, name, type, options, isPublicEligible = false, actor } = params;

    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new ValidationError('Nome do campo personalizado é obrigatório e deve ter até 100 caracteres.');
    }

    const validTypes: CustomFieldType[] = ['text', 'number', 'select', 'date'];
    if (!validTypes.includes(type)) {
      throw new ValidationError(`Tipo inválido: "${type}". Tipos suportados: ${validTypes.join(', ')}.`);
    }

    const project = await AccessService.getAuthorizedProject(projectId, actor, 'manage_project');

    // Valida e estrutura opções caso seja 'select'
    const normalizedOptions = type === 'select' ? this.normalizeOptions(options) : [];

    const field = await prisma.customField.create({
      data: {
        projectId: project.id,
        name: trimmedName,
        type,
        options: normalizedOptions as any,
        isPublicEligible: Boolean(isPublicEligible),
      },
    });

    await ActivityService.log({
      workspaceId: project.workspaceId,
      projectId: project.id,
      actor,
      action: 'custom_field.created',
      details: {
        fieldId: field.id,
        name: field.name,
        type: field.type,
        isPublicEligible: field.isPublicEligible,
      },
    });

    return {
      id: field.id,
      projectId: field.projectId,
      name: field.name,
      type: field.type as CustomFieldType,
      options: (field.options as any) || [],
      isPublicEligible: field.isPublicEligible,
      createdAt: field.createdAt.toISOString(),
      updatedAt: field.updatedAt.toISOString(),
    };
  }

  /**
   * Atualiza campo personalizado (E3.8-a / ADMIN).
   * Valida remoção de opções que estejam em uso por tarefas do projeto.
   */
  static async updateCustomField(params: {
    fieldId: string;
    name?: string;
    options?: any[];
    isPublicEligible?: boolean;
    actor: Actor;
  }): Promise<CustomFieldDTO> {
    const { fieldId, name, options, isPublicEligible, actor } = params;

    const field = await prisma.customField.findUnique({
      where: { id: fieldId },
      include: { project: true },
    });

    if (!field) {
      throw new NotFoundError('Campo personalizado não encontrado.');
    }

    await AccessService.getAuthorizedProject(field.projectId, actor, 'manage_project');

    const updateData: any = {};

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 100) {
        throw new ValidationError('Nome deve ter entre 1 e 100 caracteres.');
      }
      updateData.name = trimmed;
    }

    if (isPublicEligible !== undefined) {
      updateData.isPublicEligible = Boolean(isPublicEligible);
    }

    if (field.type === 'select' && options !== undefined) {
      const currentOptions: CustomFieldOption[] = Array.isArray(field.options) ? (field.options as any) : [];
      const newOptions = this.normalizeOptions(options);

      // Verifica se alguma opção que está sendo removida está em uso por tarefas ativas
      const currentIds = new Set(currentOptions.map((o) => o.id));
      const newIds = new Set(newOptions.map((o) => o.id));
      const removedIds = [...currentIds].filter((id) => !newIds.has(id));

      if (removedIds.length > 0) {
        const inUseCount = await prisma.customFieldValue.count({
          where: {
            fieldId: field.id,
            value: { in: removedIds },
          },
        });

        if (inUseCount > 0) {
          throw new ConflictError(
            'Não é possível remover opções que já estão em uso por tarefas ativas deste projeto.'
          );
        }
      }

      updateData.options = newOptions as any;
    }

    const updated = await prisma.customField.update({
      where: { id: fieldId },
      data: updateData,
    });

    await ActivityService.log({
      workspaceId: field.project.workspaceId,
      projectId: field.projectId,
      actor,
      action: 'custom_field.updated',
      details: {
        fieldId: field.id,
        changes: updateData,
      },
    });

    return {
      id: updated.id,
      projectId: updated.projectId,
      name: updated.name,
      type: updated.type as CustomFieldType,
      options: (updated.options as any) || [],
      isPublicEligible: updated.isPublicEligible,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Exclui campo personalizado e valores associados (E3.8-a / ADMIN).
   */
  static async deleteCustomField(fieldId: string, actor: Actor) {
    const field = await prisma.customField.findUnique({
      where: { id: fieldId },
      include: { project: true },
    });

    if (!field) {
      throw new NotFoundError('Campo personalizado não encontrado.');
    }

    await AccessService.getAuthorizedProject(field.projectId, actor, 'manage_project');

    await prisma.customField.delete({
      where: { id: fieldId },
    });

    await ActivityService.log({
      workspaceId: field.project.workspaceId,
      projectId: field.projectId,
      actor,
      action: 'custom_field.deleted',
      details: {
        fieldId,
        name: field.name,
      },
    });

    return { success: true };
  }

  /**
   * Lista todos os campos personalizados de um projeto.
   */
  static async listProjectCustomFields(
    projectId: string,
    actor: Actor
  ): Promise<CustomFieldDTO[]> {
    const project = await AccessService.getAuthorizedProject(projectId, actor, 'read_project');

    const fields = await prisma.customField.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });

    return fields.map((f) => ({
      id: f.id,
      projectId: f.projectId,
      name: f.name,
      type: f.type as CustomFieldType,
      options: (f.options as any) || [],
      isPublicEligible: f.isPublicEligible,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    }));
  }

  /**
   * Atribui ou atualiza valor de campo personalizado em uma tarefa (E3.8-a / MEMBER).
   * Invariante I8: o campo DEVE pertencer ao mesmo projeto da tarefa!
   */
  static async setTaskCustomFieldValue(params: {
    taskId: string;
    fieldId: string;
    value: any;
    actor: Actor;
  }): Promise<TaskCustomFieldValueDTO> {
    const { taskId, fieldId, value, actor } = params;

    const task = await AccessService.getAuthorizedTask(taskId, actor, 'edit_task');

    const field = await prisma.customField.findUnique({
      where: { id: fieldId },
    });

    if (!field) {
      throw new NotFoundError('Campo personalizado não encontrado.');
    }

    // Invariante de Pertencimento: campo do projeto A não pode ser associado à tarefa do projeto B
    if (field.projectId !== task.projectId) {
      throw new ValidationError(
        'Campo personalizado pertence a outro projeto e não pode ser associado a esta tarefa.'
      );
    }

    const { storedValue, displayValue } = this.validateFieldValue(field, value);

    if (storedValue === null) {
      // Remove o valor se fornecido nulo/vazio
      await prisma.customFieldValue.deleteMany({
        where: { taskId: task.id, fieldId: field.id },
      });
    } else {
      await prisma.customFieldValue.upsert({
        where: {
          taskId_fieldId: {
            taskId: task.id,
            fieldId: field.id,
          },
        },
        create: {
          taskId: task.id,
          fieldId: field.id,
          value: storedValue,
        },
        update: {
          value: storedValue,
        },
      });
    }

    await TaskService.incrementTaskVersion(task.id);

    await ActivityService.log({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      actor,
      action: 'task.custom_field_updated',
      details: {
        fieldId: field.id,
        fieldName: field.name,
        value: storedValue,
      },
    });

    return {
      fieldId: field.id,
      fieldName: field.name,
      fieldType: field.type as CustomFieldType,
      value: storedValue,
      displayValue,
      isPublicEligible: field.isPublicEligible,
    };
  }

  /**
   * Atualização em lote de múltiplos campos de uma tarefa (E3.8-a / MEMBER).
   */
  static async bulkSetTaskCustomFieldValues(params: {
    taskId: string;
    values: Array<{ fieldId: string; value?: any }>;
    actor: Actor;
  }): Promise<TaskCustomFieldValueDTO[]> {
    const { taskId, values, actor } = params;

    const results: TaskCustomFieldValueDTO[] = [];
    for (const item of values) {
      const res = await this.setTaskCustomFieldValue({
        taskId,
        fieldId: item.fieldId,
        value: item.value,
        actor,
      });
      results.push(res);
    }
    return results;
  }

  /**
   * Recupera todos os valores de campos de uma tarefa formatados para exibição.
   */
  static async getTaskCustomFieldValues(
    taskId: string,
    actor: Actor
  ): Promise<TaskCustomFieldValueDTO[]> {
    const task = await AccessService.getAuthorizedTask(taskId, actor, 'read_task');

    // Busca campos do projeto
    const fields = await prisma.customField.findMany({
      where: { projectId: task.projectId },
      include: {
        values: {
          where: { taskId: task.id },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return fields.map((f) => {
      const rawVal = f.values[0]?.value ?? null;
      let displayValue = rawVal;

      if (f.type === 'select' && rawVal && Array.isArray(f.options)) {
        const opt = (f.options as any[]).find((o) => o.id === rawVal);
        displayValue = opt ? opt.label : rawVal;
      }

      return {
        fieldId: f.id,
        fieldName: f.name,
        fieldType: f.type as CustomFieldType,
        value: rawVal,
        displayValue,
        isPublicEligible: f.isPublicEligible,
      };
    });
  }
}
