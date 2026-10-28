import prisma from '../db/prisma.js';
import { Actor } from '../types/auth.js';
import { AccessService } from './access.service.js';
import { ValidationError, ConflictError } from '../errors/app-error.js';

const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class LabelService {
  static async listByWorkspace(workspaceId: string, actor: Actor) {
    await AccessService.assertCan(actor, 'read_label', { workspaceId });

    const labels = await prisma.label.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { taskLabels: true },
        },
      },
    });

    return labels.map((l) => ({
      id: l.id,
      workspaceId: l.workspaceId,
      name: l.name,
      normalizedName: l.normalizedName,
      color: l.color,
      taskCount: l._count.taskLabels,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }));
  }

  static async createLabel(
    workspaceId: string,
    data: { name: string; color?: string },
    actor: Actor
  ) {
    await AccessService.assertCan(actor, 'manage_labels', { workspaceId });

    const trimmed = data.name?.trim();
    if (!trimmed || trimmed.length < 1 || trimmed.length > 50) {
      throw new ValidationError('O nome da etiqueta deve ter entre 1 e 50 caracteres.');
    }

    const color = data.color || '#64748b';
    if (!HEX_COLOR_REGEX.test(color)) {
      throw new ValidationError('A cor deve estar no formato hexadecimal válido (ex: #64748b ou #3b82f6).');
    }

    const normalizedName = trimmed.toLowerCase();

    const existing = await prisma.label.findUnique({
      where: {
        workspaceId_normalizedName: {
          workspaceId,
          normalizedName,
        },
      },
    });

    if (existing) {
      throw new ConflictError('Já existe uma etiqueta com este nome no workspace.');
    }

    const label = await prisma.label.create({
      data: {
        workspaceId,
        name: trimmed,
        normalizedName,
        color,
      },
    });

    return {
      id: label.id,
      workspaceId: label.workspaceId,
      name: label.name,
      normalizedName: label.normalizedName,
      color: label.color,
      taskCount: 0,
      createdAt: label.createdAt.toISOString(),
      updatedAt: label.updatedAt.toISOString(),
    };
  }

  static async updateLabel(
    id: string,
    data: { name?: string; color?: string },
    actor: Actor
  ) {
    const existing = await AccessService.getAuthorizedLabel(id, actor, 'manage_labels');

    const updateData: any = {};

    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed || trimmed.length < 1 || trimmed.length > 50) {
        throw new ValidationError('O nome da etiqueta deve ter entre 1 e 50 caracteres.');
      }
      const normalizedName = trimmed.toLowerCase();
      if (normalizedName !== existing.normalizedName) {
        const conflict = await prisma.label.findUnique({
          where: {
            workspaceId_normalizedName: {
              workspaceId: existing.workspaceId,
              normalizedName,
            },
          },
        });
        if (conflict) {
          throw new ConflictError('Já existe uma etiqueta com este nome no workspace.');
        }
      }
      updateData.name = trimmed;
      updateData.normalizedName = normalizedName;
    }

    if (data.color !== undefined) {
      if (!HEX_COLOR_REGEX.test(data.color)) {
        throw new ValidationError('A cor deve estar no formato hexadecimal válido (ex: #64748b).');
      }
      updateData.color = data.color;
    }

    const updated = await prisma.label.update({
      where: { id: existing.id },
      data: updateData,
      include: {
        _count: {
          select: { taskLabels: true },
        },
      },
    });

    return {
      id: updated.id,
      workspaceId: updated.workspaceId,
      name: updated.name,
      normalizedName: updated.normalizedName,
      color: updated.color,
      taskCount: updated._count.taskLabels,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  static async deleteLabel(id: string, actor: Actor) {
    const existing = await AccessService.getAuthorizedLabel(id, actor, 'manage_labels');

    await prisma.label.delete({
      where: { id: existing.id },
    });

    return { message: 'Etiqueta excluída com sucesso.' };
  }
}
