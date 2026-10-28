import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MCP_TOOLS, executeMcpTool, filterToolsForActor } from '../mcp/tools.js';
import { McpLimitsService } from '../mcp/limits.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { config } from '../config/env.js';

const callToolSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.any()).optional().default({}),
  })
  .strict();

export async function mcpRoutes(fastify: FastifyInstance) {
  // 1. Hook de contenção do MCP (E1.2-b): 503 quando desligado
  fastify.addHook('preHandler', async (request, reply) => {
    if (!config.projectsMcpEnabled) {
      return reply.status(503).send({
        code: 'MCP_DISABLED',
        message: 'Acesso MCP ao módulo de projetos está temporariamente desabilitado.',
        requestId: request.id,
      });
    }

    // 2. Validação explícita de Origin contra CSRF/DNS Rebinding (E4.3-a / S4)
    if (!McpLimitsService.validateOrigin(request.headers.origin)) {
      return reply.status(403).send({
        code: 'FORBIDDEN_ORIGIN',
        message: 'Origem não autorizada para o endpoint MCP.',
        requestId: request.id,
      });
    }
  });

  const mcpConfig = {
    config: {
      isPublic: true,
      policy: {
        action: 'mcp_operation',
        resource: 'mcp',
      },
    },
  };

  // ========================================================
  // Rota Canônica Streamable HTTP / JSON-RPC 2.0 (POST /mcp)
  // ========================================================
  fastify.post('/mcp', mcpConfig, async (request, reply) => {
    const body = request.body as any;
    if (!body || body.jsonrpc !== '2.0') {
      return reply.status(400).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request: expected jsonrpc 2.0' },
        id: body?.id ?? null,
      });
    }

    const { method, params, id } = body;

    // Handshake do protocolo MCP (2024-11-05 e 2025-11-25)
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'evo-projects-mcp',
            version: '2.0.0',
          },
        },
        id,
      };
    }

    if (method === 'notifications/initialized') {
      return reply.status(204).send();
    }

    // Para qualquer operação além de handshake, exige autenticação válida (E4.3-b)
    if (!request.actor) {
      await authMiddleware(request, reply);
      if (reply.sent) return;
    }

    if (!request.actor) {
      return reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Autenticação necessária para operações MCP.' },
        id,
      });
    }

    // tools/list: catálogo filtrado pelas permissões do ator (E4.3-c)
    if (method === 'tools/list') {
      const allowedTools = filterToolsForActor(MCP_TOOLS, request.actor);
      return {
        jsonrpc: '2.0',
        result: { tools: allowedTools },
        id,
      };
    }

    // tools/call: execução segura de ferramenta com rate limit e concorrência (E4.3-c / E4.3-e)
    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (!toolName) {
        return reply.status(400).send({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Parâmetro "name" da ferramenta é obrigatório.' },
          id,
        });
      }

      // Rate limit por credencial/ator
      const rateCheck = await McpLimitsService.checkRateLimit(request.actor.id, toolName);
      if (!rateCheck.allowed) {
        return reply.status(429).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Limite de requisições MCP excedido. Tente novamente mais tarde.' },
          id,
        });
      }

      // Limite de concorrência por ator
      const slotAcquired = McpLimitsService.acquireSlot(request.actor.id);
      if (!slotAcquired) {
        return reply.status(429).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Limite de concorrência MCP excedido.' },
          id,
        });
      }

      try {
        const result = await executeMcpTool(toolName, toolArgs, request.actor);
        return {
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
          id,
        };
      } catch (err: any) {
        const message = err?.message || 'Erro interno na execução da ferramenta.';
        return reply.status(err?.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 200).send({
          jsonrpc: '2.0',
          error: {
            code: err?.code === 'FORBIDDEN' ? -32003 : -32000,
            message,
          },
          id,
        });
      } finally {
        McpLimitsService.releaseSlot(request.actor.id);
      }
    }

    return reply.status(404).send({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Método MCP não suportado: '${method}'` },
      id,
    });
  });

  // ========================================================
  // Rotas Legadas /mcp/tools e /mcp/call (E4.3-d)
  // Mantidas com mesmos controles de segurança e aviso de depreciação
  // ========================================================
  fastify.get('/mcp/tools', mcpConfig, async (request, reply) => {
    reply.header('X-Deprecated', 'Endpoint legado. Utilize o endpoint JSON-RPC 2.0 padrão em POST /mcp.');

    if (!request.actor) {
      await authMiddleware(request, reply);
      if (reply.sent) return;
    }

    const tools = filterToolsForActor(MCP_TOOLS, request.actor);
    return { tools };
  });

  fastify.post('/mcp/call', mcpConfig, async (request, reply) => {
    reply.header('X-Deprecated', 'Endpoint legado. Utilize o endpoint JSON-RPC 2.0 padrão em POST /mcp.');

    if (!request.actor) {
      await authMiddleware(request, reply);
      if (reply.sent) return;
    }

    const parsed = callToolSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        isError: true,
        content: [{ type: 'text', text: parsed.error.issues[0]?.message || 'Requisição inválida' }],
      });
    }

    const { name, arguments: toolArgs } = parsed.data;

    // Rate limit
    const rateCheck = await McpLimitsService.checkRateLimit(request.actor!.id, name);
    if (!rateCheck.allowed) {
      return reply.status(429).send({
        isError: true,
        content: [{ type: 'text', text: 'Limite de requisições MCP excedido.' }],
      });
    }

    // Concorrência
    const slotAcquired = McpLimitsService.acquireSlot(request.actor!.id);
    if (!slotAcquired) {
      return reply.status(429).send({
        isError: true,
        content: [{ type: 'text', text: 'Limite de concorrência MCP excedido.' }],
      });
    }

    try {
      const result = await executeMcpTool(name, toolArgs, request.actor);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      const message = err?.message || 'Falha na execução da ferramenta MCP.';
      return reply.status(err?.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500).send({
        isError: true,
        content: [{ type: 'text', text: message }],
      });
    } finally {
      McpLimitsService.releaseSlot(request.actor!.id);
    }
  });
}
