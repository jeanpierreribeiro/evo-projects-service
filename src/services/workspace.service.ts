import prisma from '../db/prisma.js';
import { WorkspaceRole } from '@prisma/client';
import { ActivityService } from './activity.service.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

export class WorkspaceService {
  static async listUserWorkspaces(user: { id: string; email: string; name: string }) {
    let memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: {
        workspace: {
          include: {
            _count: {
              select: {
                projects: true,
                members: true,
                tasks: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // If user has no workspaces, bootstrap a default workspace for them
    if (memberships.length === 0) {
      const defaultWorkspace = await this.createWorkspace(
        {
          name: 'Operação Principal',
          description: 'Workspace principal para projetos e demandas',
          color: '#3b82f6',
        },
        user
      );

      const createdMembership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: defaultWorkspace.id,
            userId: user.id,
          },
        },
        include: {
          workspace: {
            include: {
              _count: {
                select: {
                  projects: true,
                  members: true,
                  tasks: true,
                },
              },
            },
          },
        },
      });

      if (createdMembership) {
        return [createdMembership.workspace];
      }
    }

    return memberships.map((m) => m.workspace);
  }

  static async createWorkspace(
    data: { name: string; description?: string; color?: string; avatarUrl?: string },
    user: { id: string; email: string; name: string }
  ) {
    let slug = slugify(data.name);
    let count = 1;
    while (await prisma.workspace.findUnique({ where: { slug } })) {
      slug = `${slugify(data.name)}-${count++}`;
    }

    const workspace = await prisma.workspace.create({
      data: {
        name: data.name,
        slug,
        description: data.description,
        color: data.color || '#3b82f6',
        avatarUrl: data.avatarUrl,
        members: {
          create: {
            userId: user.id,
            email: user.email,
            name: user.name,
            role: WorkspaceRole.ADMIN,
          },
        },
      },
    });

    await ActivityService.log({
      workspaceId: workspace.id,
      userId: user.id,
      userName: user.name,
      action: 'created_workspace',
      details: { workspaceName: workspace.name },
    });

    return workspace;
  }

  static async getWorkspace(id: string) {
    return prisma.workspace.findFirst({
      where: {
        OR: [{ id }, { slug: id }],
      },
      include: {
        members: true,
        _count: {
          select: { projects: true, tasks: true, members: true },
        },
      },
    });
  }

  static async updateWorkspace(
    id: string,
    data: { name?: string; description?: string; color?: string; avatarUrl?: string }
  ) {
    return prisma.workspace.update({
      where: { id },
      data,
    });
  }

  static async deleteWorkspace(id: string) {
    return prisma.workspace.delete({
      where: { id },
    });
  }

  static async listMembers(workspaceId: string) {
    return prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  static async addMember(
    workspaceId: string,
    data: { userId: string; email: string; name: string; role?: WorkspaceRole; avatarUrl?: string },
    actor: { id: string; name: string }
  ) {
    const member = await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: data.userId,
        },
      },
      update: {
        role: data.role || WorkspaceRole.MEMBER,
        name: data.name,
        email: data.email,
        avatarUrl: data.avatarUrl,
      },
      create: {
        workspaceId,
        userId: data.userId,
        email: data.email,
        name: data.name,
        role: data.role || WorkspaceRole.MEMBER,
        avatarUrl: data.avatarUrl,
      },
    });

    await ActivityService.log({
      workspaceId,
      userId: actor.id,
      userName: actor.name,
      action: 'added_member',
      details: { memberName: data.name, memberRole: member.role },
    });

    return member;
  }

  static async removeMember(workspaceId: string, memberId: string, actor: { id: string; name: string }) {
    const member = await prisma.workspaceMember.delete({
      where: { id: memberId },
    });

    await ActivityService.log({
      workspaceId,
      userId: actor.id,
      userName: actor.name,
      action: 'removed_member',
      details: { memberName: member.name },
    });

    return member;
  }
}
