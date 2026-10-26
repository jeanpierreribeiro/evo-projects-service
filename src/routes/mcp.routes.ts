import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MCP_TOOLS, executeMcpTool } from '../mcp/tools.js';

const callToolSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.any()).optional().default({}),
});

export async function mcpRoutes(fastify: FastifyInstance) {
  // GET /mcp/tools - Returns tool manifest
  fastify.get('/mcp/tools', async () => {
    return {
      tools: MCP_TOOLS,
    };
  });

  // POST /mcp/call - Direct tool call
  fastify.post('/mcp/call', async (request, reply) => {
    const parsed = callToolSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        isError: true,
        content: [{ type: 'text', text: parsed.error.issues[0]?.message || 'Requisição inválida' }],
      });
    }

    try {
      const result = await executeMcpTool(parsed.data.name, parsed.data.arguments);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return reply.status(400).send({
        isError: true,
        content: [{ type: 'text', text: err.message || 'Erro ao executar ferramenta' }],
      });
    }
  });

  // POST /mcp - JSON-RPC 2.0 endpoint for standard MCP clients
  fastify.post('/mcp', async (request, reply) => {
    const body = request.body as any;
    const id = body?.id ?? 1;

    if (body?.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    if (body?.method === 'tools/call') {
      const toolName = body?.params?.name;
      const toolArgs = body?.params?.arguments || {};

      try {
        const result = await executeMcpTool(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err.message || 'Erro interno ao executar ferramenta MCP',
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Método JSON-RPC não suportado: ${body?.method}`,
      },
    };
  });
}
