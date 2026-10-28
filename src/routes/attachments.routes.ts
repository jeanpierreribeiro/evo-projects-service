import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AttachmentService } from '../services/attachment.service.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { ValidationError } from '../errors/app-error.js';
import { LIMITS } from '../config/limits.js';

export async function attachmentsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authMiddleware);

  // POST /tasks/:taskId/attachments - Upload de anexo multipart autenticado (E3.7-b)
  fastify.post(
    '/tasks/:taskId/attachments',
    {
      config: {
        policy: {
          action: 'create_resource',
          resource: 'attachment',
          minRole: 'MEMBER',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { taskId: string } }>,
      reply: FastifyReply
    ) => {
      const { taskId } = request.params;
      const actor = request.actor!;

      if (!request.isMultipart()) {
        throw new ValidationError('Requisição deve ser multipart/form-data.');
      }

      const fileData = await request.file();
      if (!fileData) {
        throw new ValidationError('Nenhum arquivo enviado no formulário.');
      }

      const buffer = await fileData.toBuffer();
      const commentId = (fileData.fields.commentId as any)?.value;

      const attachment = await AttachmentService.uploadAttachment({
        taskId,
        commentId,
        filename: fileData.filename,
        buffer,
        actor,
      });

      return reply.status(201).send({ data: attachment });
    }
  );

  // GET /tasks/:taskId/attachments - Listagem de anexos de uma tarefa (E3.7-b)
  fastify.get(
    '/tasks/:taskId/attachments',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'task',
          minRole: 'VIEWER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { taskId: string } }>) => {
      const { taskId } = request.params;
      const actor = request.actor!;

      const attachments = await AttachmentService.listTaskAttachments(taskId, actor);
      return { data: attachments };
    }
  );

  // GET /attachments/:id/download - Download interno de anexo autenticado (E3.7-c)
  fastify.get(
    '/attachments/:id/download',
    {
      config: {
        policy: {
          action: 'read_task',
          resource: 'attachment',
          minRole: 'VIEWER',
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const { id } = request.params;
      const actor = request.actor!;

      const { attachment, fileResult } =
        await AttachmentService.getAttachmentForInternalDownload(id, actor);

      const safeInlineTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      const disposition = safeInlineTypes.includes(attachment.mimeType)
        ? 'inline'
        : `attachment; filename="${attachment.filename}"`;

      reply.header('Content-Type', attachment.mimeType);
      reply.header('Content-Disposition', disposition);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'");
      reply.header('Cache-Control', 'private, no-cache');

      return reply.send(fileResult.stream);
    }
  );

  // DELETE /attachments/:id - Exclusão de anexo (E3.7-c)
  fastify.delete(
    '/attachments/:id',
    {
      config: {
        policy: {
          action: 'delete_resource',
          resource: 'attachment',
          minRole: 'MEMBER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const actor = request.actor!;

      await AttachmentService.deleteAttachment(id, actor);
      return { message: 'Anexo removido com sucesso.' };
    }
  );

  // GET /workspaces/:workspaceId/attachments/storage-usage - Cota e uso de armazenamento (E3.7-e)
  fastify.get(
    '/workspaces/:workspaceId/attachments/storage-usage',
    {
      config: {
        policy: {
          action: 'read_workspace',
          resource: 'workspace',
          minRole: 'VIEWER',
        },
      },
    },
    async (request: FastifyRequest<{ Params: { workspaceId: string } }>) => {
      const { workspaceId } = request.params;

      const usageBytes = await AttachmentService.getWorkspaceStorageUsage(workspaceId);
      const quotaBytes = LIMITS.ATTACHMENT_MAX_WORKSPACE_BYTES;
      const usagePercent = Number(((usageBytes / quotaBytes) * 100).toFixed(2));

      return {
        data: {
          workspaceId,
          usageBytes,
          quotaBytes,
          usagePercent,
        },
      };
    }
  );
}
