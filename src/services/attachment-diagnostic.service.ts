import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import prisma from '../db/prisma.js';

export interface AttachmentDiagnosticReport {
  timestamp: string;
  totalDbAttachmentsCount: number;
  totalDbAttachmentsBytes: number;
  activeAttachmentsCount: number;
  softDeletedTaskAttachmentsCount: number;
  physicalFilesCount: number;
  physicalFilesBytes: number;
  orphanPhysicalFilesCount: number;
  orphanPhysicalFilesBytes: number;
  orphanStorageKeys: string[];
  reconciliationStatus: 'CONSISTENT' | 'ORPHANS_DETECTED' | 'MISSING_PHYSICAL_FILES';
  policyNote: string;
}

export class AttachmentDiagnosticService {
  /**
   * Executa auditoria e diagnóstico de reconciliação de armazenamento (E3.7-e / Seção 7.4 / Seção 17).
   * - Compara banco de dados vs arquivos físicos no storage.
   * - Identifica arquivos órfãos sem apagar nenhum arquivo fisicamente (não-purga automática).
   */
  static async runDiagnostic(): Promise<AttachmentDiagnosticReport> {
    const baseDir = path.resolve(
      process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'storage', 'attachments')
    );

    // 1. Consulta metadados no banco de dados
    const dbAttachments = await prisma.attachment.findMany({
      select: {
        id: true,
        storageKey: true,
        sizeBytes: true,
        task: {
          select: { id: true, deletedAt: true, isArchived: true },
        },
      },
    });

    const totalDbAttachmentsCount = dbAttachments.length;
    const totalDbAttachmentsBytes = dbAttachments.reduce((sum, a) => sum + a.sizeBytes, 0);

    const activeAttachmentsCount = dbAttachments.filter(
      (a) => !a.task.deletedAt
    ).length;

    const softDeletedTaskAttachmentsCount = dbAttachments.filter(
      (a) => Boolean(a.task.deletedAt)
    ).length;

    const dbStorageKeys = new Set(dbAttachments.map((a) => a.storageKey.replace(/\\/g, '/')));

    // 2. Varreria física do storage local
    const physicalFiles: Array<{ relativePath: string; sizeBytes: number }> = [];

    async function scanDir(currentDir: string, relativePrefix = '') {
      try {
        const entries = await fsp.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(currentDir, entry.name);
          const relPath = path.join(relativePrefix, entry.name).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            await scanDir(entryPath, relPath);
          } else if (entry.isFile() && !entry.name.includes('.tmp.')) {
            const stats = await fsp.stat(entryPath);
            physicalFiles.push({ relativePath: relPath, sizeBytes: stats.size });
          }
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    await scanDir(baseDir);

    const physicalFilesCount = physicalFiles.length;
    const physicalFilesBytes = physicalFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

    // 3. Cruzamento para identificação de órfãos
    const orphanFiles = physicalFiles.filter(
      (f) => !dbStorageKeys.has(f.relativePath)
    );

    const missingPhysicalFiles = dbAttachments.filter(
      (a) => !physicalFiles.some((f) => f.relativePath === a.storageKey.replace(/\\/g, '/'))
    );

    let reconciliationStatus: 'CONSISTENT' | 'ORPHANS_DETECTED' | 'MISSING_PHYSICAL_FILES' = 'CONSISTENT';
    if (missingPhysicalFiles.length > 0) {
      reconciliationStatus = 'MISSING_PHYSICAL_FILES';
    } else if (orphanFiles.length > 0) {
      reconciliationStatus = 'ORPHANS_DETECTED';
    }

    return {
      timestamp: new Date().toISOString(),
      totalDbAttachmentsCount,
      totalDbAttachmentsBytes,
      activeAttachmentsCount,
      softDeletedTaskAttachmentsCount,
      physicalFilesCount,
      physicalFilesBytes,
      orphanPhysicalFilesCount: orphanFiles.length,
      orphanPhysicalFilesBytes: orphanFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
      orphanStorageKeys: orphanFiles.map((f) => f.relativePath),
      reconciliationStatus,
      policyNote:
        'Conforme política de retenção (docs/politica-retencao.md), arquivos órfãos são apenas catalogados e diagnosticados. Nenhuma purga física automática é executada.',
    };
  }
}
