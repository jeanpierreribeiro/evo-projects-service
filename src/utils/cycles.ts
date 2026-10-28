import { Prisma, RelationType } from '@prisma/client';

/**
 * Detecção de ciclos em grafo de dependências BLOCKS (E3.4-c / T12).
 * Verifica se a inserção da aresta direcionada (candidateFromId -> candidateToId)
 * criaria um ciclo circular de bloqueios no projeto.
 */
export async function wouldCreateBlockCycle(
  projectId: string,
  candidateFromId: string,
  candidateToId: string,
  tx: Prisma.TransactionClient
): Promise<boolean> {
  // Autorreferência direta
  if (candidateFromId === candidateToId) {
    return true;
  }

  // Busca todas as relações de dependência do tipo BLOCKS no mesmo projeto
  const relations = await tx.taskRelation.findMany({
    where: {
      type: RelationType.BLOCKS,
      task: { projectId },
      relatedTask: { projectId },
    },
    select: {
      taskId: true,
      relatedTaskId: true,
    },
  });

  // Constrói lista de adjacência
  const adj = new Map<string, string[]>();
  for (const rel of relations) {
    const list = adj.get(rel.taskId) || [];
    list.push(rel.relatedTaskId);
    adj.set(rel.taskId, list);
  }

  // Busca em largura (BFS) a partir de candidateToId:
  // Se alcançarmos candidateFromId, significa que candidateFromId já é dependente
  // transitivo de candidateToId, e portanto candidateFromId -> candidateToId fecharia um ciclo.
  const queue: string[] = [candidateToId];
  const visited = new Set<string>([candidateToId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === candidateFromId) {
      return true;
    }

    const neighbors = adj.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return false;
}
