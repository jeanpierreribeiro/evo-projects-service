import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { validateFileBuffer } from '../src/utils/file-validator.js';
import { sanitizeAndRewriteMarkdown, buildPublicCard } from '../src/share/public-card.js';
import { AttachmentService } from '../src/services/attachment.service.js';
import { AttachmentDiagnosticService } from '../src/services/attachment-diagnostic.service.js';
import { getStorageProvider } from '../src/storage/index.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { LIMITS } from '../src/config/limits.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../src/errors/app-error.js';
import { Actor } from '../src/types/auth.js';
import prisma from '../src/db/prisma.js';
import { generateShareToken, hashToken, generateSharePin, hashPin } from '../src/share/crypto.js';
import { createTestJwt } from './helpers/auth.js';
import { AuthClient } from '../src/auth/auth-client.js';

// Mock do AuthClient para requisições autenticadas via buildApp().inject()
vi.mock('../src/auth/auth-client.js', () => ({
  AuthClient: {
    validateToken: vi.fn(),
  },
  AuthServiceUnavailableError: class extends Error {},
}));

describe('E3.7 & T10 - Anexos, Validação de Bytes, Markdown Seguro, Armazenamento e Diagnóstico', () => {
  const app = buildApp();

  // Buffers de teste
  const validPngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const validJpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const validPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const validCsvBuffer = Buffer.from('id,name,value\n1,alpha,100\n2,beta,200\n');
  const validTxtBuffer = Buffer.from('Este é um documento de texto simples e legítimo.');

  let testWorkspaceId: string;
  let testProjectId: string;
  let testTaskId: string;
  let adminUserId: string;
  let memberUserId: string;
  let adminActor: Actor;
  let memberActor: Actor;
  let adminJwt: string;

  beforeEach(async () => {
    config.projectsSharingEnabled = true;

    // Busca workspace seed
    const ws = await prisma.workspace.findUnique({
      where: { slug: 'operacao-principal' },
      include: {
        members: true,
        projects: {
          orderBy: { createdAt: 'asc' },
          include: {
            tasks: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });

    if (!ws || !ws.projects[0] || !ws.projects[0].tasks[0]) {
      throw new Error('Workspace seed, projeto ou tarefa não encontrados para testes de anexos.');
    }

    testWorkspaceId = ws.id;
    // Garante uma tarefa ativa (não deletada) para os testes de anexos
    const project = ws.projects[0];
    testProjectId = project.id;

    let activeTask = await prisma.task.findFirst({
      where: {
        projectId: project.id,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!activeTask) {
      const col = await prisma.column.findFirst({
        where: { projectId: project.id },
      });
      activeTask = await prisma.task.create({
        data: {
          workspaceId: ws.id,
          projectId: project.id,
          columnId: col!.id,
          title: 'Tarefa Ativa Teste Anexos',
          createdById: adminUserId,
          taskNumber: Math.floor(Math.random() * 80000) + 10000,
        },
      });
    }

    testTaskId = activeTask.id;

    const admin = ws.members.find((m) => m.role === 'ADMIN' && m.status === 'ACTIVE');
    if (!admin) {
      throw new Error('Admin ativo não encontrado no workspace.');
    }
    adminUserId = admin.userId;

    const member = await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: ws.id,
          userId: 'test-member-attachment-user-id',
        },
      },
      create: {
        workspaceId: ws.id,
        userId: 'test-member-attachment-user-id',
        email: 'member-att@jpros.local',
        name: 'Membro Anexo',
        role: 'MEMBER',
        status: 'ACTIVE',
      },
      update: {
        role: 'MEMBER',
        status: 'ACTIVE',
      },
    });
    memberUserId = member.userId;

    adminActor = {
      type: 'user',
      id: adminUserId,
      email: admin.email,
      name: admin.name,
    };

    memberActor = {
      type: 'user',
      id: memberUserId,
      email: member.email,
      name: member.name,
    };

    adminJwt = await createTestJwt({
      sub: adminUserId,
      email: admin.email,
      name: admin.name,
      role: 'ADMIN',
    });

    // Mock do AuthClient para validar o adminJwt
    vi.mocked(AuthClient.validateToken).mockResolvedValue({
      valid: true,
      user: {
        id: adminUserId,
        email: admin.email,
        name: admin.name,
        role: 'ADMIN',
      },
    });
  });

  describe('1. Validação de Arquivos e Bytes (validateFileBuffer)', () => {
    it('deve aceitar arquivos legítimos com magic bytes corretos', () => {
      const pngRes = validateFileBuffer(validPngHeader, 'foto.png');
      expect(pngRes.mimeType).toBe('image/png');
      expect(pngRes.extension).toBe('.png');

      const jpegRes = validateFileBuffer(validJpegHeader, 'documento.jpg');
      expect(jpegRes.mimeType).toBe('image/jpeg');

      const pdfRes = validateFileBuffer(validPdfBuffer, 'relatorio.pdf');
      expect(pdfRes.mimeType).toBe('application/pdf');

      const csvRes = validateFileBuffer(validCsvBuffer, 'planilha.csv');
      expect(csvRes.mimeType).toBe('text/csv');

      const txtRes = validateFileBuffer(validTxtBuffer, 'notas.txt');
      expect(txtRes.mimeType).toBe('text/plain');
    });

    it('deve rejeitar extensão com spoofing (conteúdo não bate com a extensão declarada)', () => {
      // Texto simples com extensão .png
      expect(() => {
        validateFileBuffer(Buffer.from('isto não é png'), 'falso.png');
      }).toThrow(ValidationError);

      // PDF falso
      expect(() => {
        validateFileBuffer(Buffer.from('not a pdf'), 'falso.pdf');
      }).toThrow(ValidationError);
    });

    it('deve rejeitar extensões perigosas ou não permitidas (.exe, .sh, .html, .svg)', () => {
      expect(() => {
        validateFileBuffer(Buffer.from('MZ...'), 'programa.exe');
      }).toThrow(ValidationError);

      expect(() => {
        validateFileBuffer(Buffer.from('#!/bin/bash\nrm -rf /'), 'script.sh');
      }).toThrow(ValidationError);

      expect(() => {
        validateFileBuffer(Buffer.from('<!DOCTYPE html><html><body>oi</body></html>'), 'index.html');
      }).toThrow(ValidationError);

      expect(() => {
        validateFileBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'imagem.svg');
      }).toThrow(ValidationError);
    });

    it('deve rejeitar arquivos poliglotas contendo injeções executáveis nos primeiros 8KB', () => {
      // PNG válido no cabeçalho, mas contendo tag <script> embutida
      const polyglotPng = Buffer.concat([
        validPngHeader,
        Buffer.from('some data <script>alert("pwned")</script> ending'),
      ]);

      expect(() => {
        validateFileBuffer(polyglotPng, 'polyglot.png');
      }).toThrow(ValidationError);
      expect(() => {
        validateFileBuffer(polyglotPng, 'polyglot.png');
      }).toThrow(/conteúdo executável/i);

      // PNG com handler onerror=
      const polyglotHandler = Buffer.concat([
        validPngHeader,
        Buffer.from('some data onerror=alert(1) test'),
      ]);
      expect(() => {
        validateFileBuffer(polyglotHandler, 'handler.png');
      }).toThrow(ValidationError);
    });

    it('deve sanitizar nomes de arquivos com caracteres inseguros e path traversal', () => {
      const res = validateFileBuffer(validPngHeader, '../../../etc/passwd_image.png');
      expect(res.sanitizedFilename).not.toContain('../');
      expect(res.sanitizedFilename).toMatch(/^[a-zA-Z0-9._-]+$/);
    });
  });

  describe('2. Markdown Seguro e Reescrita de Imagens (sanitizeAndRewriteMarkdown & buildPublicCard)', () => {
    it('deve remover tags e atributos perigosos mantendo markdown válido', () => {
      const input = `
# Título da Tarefa
Texto normal com **negrito** e [link seguro](https://example.com).
<script>alert('xss')</script>
<iframe src="https://attacker.com"></iframe>
<svg onload="alert(1)"></svg>
<img src="about:blank" onerror="alert(2)" />
[Link JS](javascript:alert(1))
`;
      const output = sanitizeAndRewriteMarkdown(input);
      expect(output).not.toContain('<script>');
      expect(output).not.toContain('<iframe>');
      expect(output).not.toContain('<svg');
      expect(output).not.toContain('onerror=');
      expect(output).not.toContain('javascript:');
      expect(output).toContain('Texto normal com **negrito**');
    });

    it('deve reescrever imagens referenciando anexos autorizados e mascarar não autorizados', () => {
      const input = `
![Foto da Fachada](/api/v1/projects/attachments/att-101/download)
![Planta Baixa](attachments/att-102)
![Imagem Externa](https://images.unsplash.com/photo-1)
`;
      const shareToken = 'token-pub-xyz';
      const selectedAttachmentIds = ['att-101']; // att-102 NÃO selecionado

      const output = sanitizeAndRewriteMarkdown(input, {
        selectedAttachmentIds,
        shareToken,
      });

      // Anexo selecionado reescrito para o endpoint do share
      expect(output).toContain(
        `![Foto da Fachada](/api/v1/projects/public/shares/${shareToken}/attachments/att-101)`
      );

      // Anexo não selecionado substituído por about:blank seguro
      expect(output).toContain('![Planta Baixa](about:blank)');

      // Imagem externa mantida intacta
      expect(output).toContain('![Imagem Externa](https://images.unsplash.com/photo-1)');
    });

    it('buildPublicCard deve incluir estritamente os anexos explicitamente selecionados que não sejam de comentários', () => {
      const task = {
        id: 'task-card-1',
        title: 'Tarefa Card',
        description: 'Descrição com ![Anexo](attachments/att-1)',
        column: { name: 'Em Andamento' },
        priority: 'HIGH',
        attachments: [
          { id: 'att-1', filename: 'anexo1.png', mimeType: 'image/png', sizeBytes: 1024, commentId: null },
          { id: 'att-2', filename: 'anexo2.pdf', mimeType: 'application/pdf', sizeBytes: 2048, commentId: null },
          { id: 'att-3', filename: 'comentario.png', mimeType: 'image/png', sizeBytes: 512, commentId: 'comm-1' },
        ],
      };

      const card = buildPublicCard(task, {
        showAttachments: true,
        selectedAttachmentIds: ['att-1', 'att-3'], // att-3 é de comentário!
        shareToken: 'test-token',
      });

      expect(card.attachments).toBeDefined();
      expect(card.attachments).toHaveLength(1);
      expect(card.attachments![0].id).toBe('att-1');
      expect(card.attachments![0].downloadUrl).toBe(
        '/api/v1/projects/public/shares/test-token/attachments/att-1'
      );
      // att-3 de comentário NUNCA deve ser incluído
      expect(card.attachments!.some((a) => a.id === 'att-3')).toBe(false);
    });
  });

  describe('3. Ciclo de Vida de Anexos no Serviço (AttachmentService)', () => {
    let createdAttachmentId: string;

    it('deve realizar upload com sucesso calculando SHA-256 e gravando no storage', async () => {
      const attachment = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        filename: 'grafico-teste.png',
        buffer: validPngHeader,
        actor: memberActor,
      });

      expect(attachment.id).toBeDefined();
      expect(attachment.filename).toBe('grafico-teste.png');
      expect(attachment.mimeType).toBe('image/png');
      expect(attachment.sizeBytes).toBe(validPngHeader.length);
      expect(attachment.hashSha256).toBe(
        crypto.createHash('sha256').update(validPngHeader).digest('hex')
      );
      expect(attachment.uploadedById).toBe(memberUserId);

      createdAttachmentId = attachment.id;

      // Valida gravação física no storage
      const dbRecord = await prisma.attachment.findUnique({
        where: { id: attachment.id },
      });
      expect(dbRecord).not.toBeNull();

      const physical = await getStorageProvider().get(dbRecord!.storageKey);
      expect(physical).not.toBeNull();
      expect(physical!.sizeBytes).toBe(validPngHeader.length);
    });

    it('deve listar anexos da tarefa para membros autorizados', async () => {
      const att = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        filename: 'lista-teste.png',
        buffer: validPngHeader,
        actor: memberActor,
      });
      const list = await AttachmentService.listTaskAttachments(testTaskId, memberActor);
      expect(list.some((a) => a.id === att.id)).toBe(true);
    });

    it('deve permitir download interno com stream e metadados corretos', async () => {
      const result = await AttachmentService.getAttachmentForInternalDownload(
        createdAttachmentId,
        memberActor
      );
      expect(result.attachment.id).toBe(createdAttachmentId);
      expect(result.fileResult.stream).toBeDefined();
    });

    it('deve rejeitar upload com tamanho superior a 20 MiB', async () => {
      // Cria buffer simulado maior que 20 MiB
      const largeBuffer = Buffer.alloc(LIMITS.ATTACHMENT_MAX_SIZE_BYTES + 1024);
      // Preenche cabeçalho PNG para passar no validador se fosse checado
      validPngHeader.copy(largeBuffer, 0);

      await expect(
        AttachmentService.uploadAttachment({
          taskId: testTaskId,
          filename: 'pesado.png',
          buffer: largeBuffer,
          actor: memberActor,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('deve vincular anexo a comentário válido e rejeitar se o comentário pertencer a outra tarefa', async () => {
      const comment = await prisma.comment.create({
        data: {
          taskId: testTaskId,
          userId: memberUserId,
          userName: memberActor.name,
          content: 'Comentário com anexo',
        },
      });

      const attWithComment = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        commentId: comment.id,
        filename: 'evidencia-comentario.pdf',
        buffer: validPdfBuffer,
        actor: memberActor,
      });

      expect(attWithComment.commentId).toBe(comment.id);
      expect(attWithComment.isCommentAttachment).toBe(true);

      // Comentário inexistente
      await expect(
        AttachmentService.uploadAttachment({
          taskId: testTaskId,
          commentId: 'comment-inexistente-123',
          filename: 'falha.pdf',
          buffer: validPdfBuffer,
          actor: memberActor,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('deve excluir anexo física e logicamente com permissão de autor ou ADMIN', async () => {
      // Exclusão pelo membro autor
      const res = await AttachmentService.deleteAttachment(createdAttachmentId, memberActor);
      expect(res.success).toBe(true);

      // Verifica que sumiu do banco
      const checkDb = await prisma.attachment.findUnique({
        where: { id: createdAttachmentId },
      });
      expect(checkDb).toBeNull();
    });
  });

  describe('4. Download Público por Share com PIN e Invariantes de Segurança (E3.7-c / T10)', () => {
    let shareToken: string;
    let shareAttachmentId: string;
    let privateAttachmentId: string;
    let commentAttachmentId: string;

    beforeEach(async () => {
      shareToken = generateShareToken();
      const tokenHash = hashToken(shareToken);
      const pinHash = await hashPin('654321');

      // Cria 1 anexo selecionado
      const att1 = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        filename: 'anexo-publico.pdf',
        buffer: validPdfBuffer,
        actor: adminActor,
      });
      shareAttachmentId = att1.id;

      // Cria 1 anexo não selecionado
      const att2 = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        filename: 'anexo-privado.pdf',
        buffer: validPdfBuffer,
        actor: adminActor,
      });
      privateAttachmentId = att2.id;

      // Cria comentário e anexo de comentário
      const comment = await prisma.comment.create({
        data: {
          taskId: testTaskId,
          userId: adminUserId,
          userName: adminActor.name,
          content: 'Comentário confidencial',
        },
      });
      const attComm = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        commentId: comment.id,
        filename: 'anexo-comentario.png',
        buffer: validPngHeader,
        actor: adminActor,
      });
      commentAttachmentId = attComm.id;

      // Cria registro de Share com seleção explícita de shareAttachmentId
      await prisma.taskShare.create({
        data: {
          taskId: testTaskId,
          workspaceId: testWorkspaceId,
          tokenHash,
          pinHash,
          createdById: adminUserId,
          createdByActorType: 'user',
          showAttachments: true,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          attachments: {
            create: [
              {
                attachmentId: shareAttachmentId,
              },
            ],
          },
        },
      });
    });

    it('deve permitir download público via token para anexo explicitamente selecionado', async () => {
      const result = await AttachmentService.getAttachmentForPublicDownload(
        shareToken,
        shareAttachmentId
      );
      expect(result.attachment.id).toBe(shareAttachmentId);
      expect(result.fileResult.stream).toBeDefined();
    });

    it('deve rejeitar download público de anexo da mesma tarefa que NÃO foi selecionado (404)', async () => {
      await expect(
        AttachmentService.getAttachmentForPublicDownload(shareToken, privateAttachmentId)
      ).rejects.toThrow(NotFoundError);
    });

    it('deve barrar download público de anexo de comentário mesmo se forçado (Invariante de Segurança)', async () => {
      const share = await prisma.taskShare.findUnique({
        where: { tokenHash: hashToken(shareToken) },
      });

      // Mesmo se associássemos manualmente na tabela relacional:
      await prisma.taskShareAttachment.create({
        data: {
          shareId: share!.id,
          attachmentId: commentAttachmentId,
        },
      });

      await expect(
        AttachmentService.getAttachmentForPublicDownload(shareToken, commentAttachmentId)
      ).rejects.toThrow(ForbiddenError);
    });

    it('deve rejeitar download público se o share tiver sido revogado ou expirado', async () => {
      // Revoga o share
      await prisma.taskShare.update({
        where: { tokenHash: hashToken(shareToken) },
        data: { revokedAt: new Date() },
      });

      await expect(
        AttachmentService.getAttachmentForPublicDownload(shareToken, shareAttachmentId)
      ).rejects.toThrow(NotFoundError);
    });

    it('deve rejeitar download público se showAttachments for false no share', async () => {
      await prisma.taskShare.update({
        where: { tokenHash: hashToken(shareToken) },
        data: { showAttachments: false, revokedAt: null },
      });

      await expect(
        AttachmentService.getAttachmentForPublicDownload(shareToken, shareAttachmentId)
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('5. Diagnóstico de Arquivos Órfãos (AttachmentDiagnosticService)', () => {
    it('deve detectar arquivos físicos órfãos sem apagar fisicamente nenhum arquivo', async () => {
      // Cria propositalmente um arquivo físico órfão no storage
      const storageDir = path.resolve(
        process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'storage', 'attachments')
      );
      await fsp.mkdir(storageDir, { recursive: true });

      const orphanFilename = `orphan-test-${Date.now()}.png`;
      const orphanPath = path.join(storageDir, orphanFilename);
      await fsp.writeFile(orphanPath, validPngHeader);

      const report = await AttachmentDiagnosticService.runDiagnostic();

      expect(report.timestamp).toBeDefined();
      expect(report.orphanPhysicalFilesCount).toBeGreaterThanOrEqual(1);
      expect(report.orphanStorageKeys).toContain(orphanFilename);
      expect(report.reconciliationStatus).toBe('ORPHANS_DETECTED');

      // Invariante de Segurança da Política de Retenção:
      // O arquivo físico órfão NÃO pode ser deletado pela rotina de diagnóstico
      const fileStillExists = fs.existsSync(orphanPath);
      expect(fileStillExists).toBe(true);

      // Limpeza manual pós-teste
      await fsp.unlink(orphanPath).catch(() => {});
    });
  });

  describe('6. Endpoints HTTP Autenticados e de Download com Headers Seguros', () => {
    let uploadedAttId: string;

    beforeEach(async () => {
      const att = await AttachmentService.uploadAttachment({
        taskId: testTaskId,
        filename: 'icone.png',
        buffer: validPngHeader,
        actor: adminActor,
      });
      uploadedAttId = att.id;
    });

    it('GET /attachments/:id/download deve retornar headers de segurança nosniff e CSP', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/attachments/${uploadedAttId}/download`,
        headers: {
          authorization: `Bearer ${adminJwt}`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toBe('inline');
    });

    it('GET /workspaces/:workspaceId/attachments/storage-usage deve retornar uso e cota', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/workspaces/${testWorkspaceId}/attachments/storage-usage`,
        headers: {
          authorization: `Bearer ${adminJwt}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.data.workspaceId).toBe(testWorkspaceId);
      expect(json.data.usageBytes).toBeGreaterThanOrEqual(0);
      expect(json.data.quotaBytes).toBe(LIMITS.ATTACHMENT_MAX_WORKSPACE_BYTES);
    });
  });
});
