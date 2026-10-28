import prisma from '../db/prisma.js';
import { AuthUser } from '../types/index.js';

/**
 * UserProjectionService (E1.6-e)
 * Mantém projeção sincronizada de identidades do Auth no banco local do módulo de Projetos.
 * Permite desativação rápida em até 60s e preserva nomes históricos de atores em auditoria.
 */
export class UserProjectionService {
  /**
   * Sincroniza a projeção local na autorização.
   */
  static async syncUser(user: AuthUser): Promise<void> {
    if (!user || !user.id) return;

    try {
      await prisma.userProjection.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl || null,
          isActive: true,
          syncedAt: new Date(),
        },
        create: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl || null,
          isActive: true,
          syncedAt: new Date(),
        },
      });
    } catch (err) {
      // Log interno sem derrubar requisição
      console.error('Falha ao sincronizar projeção do usuário:', err);
    }
  }

  /**
   * Verifica se o usuário está ativo na projeção local.
   */
  static async isUserActive(userId: string): Promise<boolean> {
    const projection = await prisma.userProjection.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });

    if (!projection) return true;
    return projection.isActive;
  }

  /**
   * Invalida / desativa o usuário na projeção local.
   */
  static async markUserInactive(userId: string): Promise<void> {
    await prisma.userProjection.updateMany({
      where: { id: userId },
      data: { isActive: false, syncedAt: new Date() },
    });
  }
}
