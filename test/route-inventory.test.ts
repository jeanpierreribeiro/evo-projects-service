import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { MCP_TOOLS } from '../src/mcp/tools.js';

describe('E1.4-e - Portão de build de políticas e inventário estruturado', () => {
  it('todas as rotas registradas devem possuir declaração estrita de política (Portão de Build E1.4-e)', async () => {
    const app = buildApp();
    await app.ready();

    const routes = app.routeInventory || [];
    expect(routes.length).toBeGreaterThan(0);

    console.log(`\n=== INVENTÁRIO DE ROTAS REGISTRADAS COM POLÍTICA (${routes.length}) ===`);
    for (const r of routes) {
      console.log(`[${r.method}] ${r.url} -> Ação: ${r.action} | Política: ${r.policy} | Público: ${r.isPublic}`);
    }

    // Exceções permitidas: apenas /health e /ready
    const allowedExceptions = ['/health', '/ready'];

    // Encontra rotas de negócio sem política definida
    const pendingRoutes = routes.filter(
      (r) => r.policy === 'pendente' && !allowedExceptions.includes(r.url)
    );

    if (pendingRoutes.length > 0) {
      console.error(
        `FALHA NO PORTÃO DE BUILD: Encontradas ${pendingRoutes.length} rotas sem política declarada:`,
        pendingRoutes.map((r) => `[${r.method}] ${r.url}`)
      );
    }

    // O build FALHA se houver qualquer rota sem política declarada
    expect(pendingRoutes.length).toBe(0);
  });

  it('deve listar todas as ferramentas MCP catalogadas', () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);

    console.log(`\n=== INVENTÁRIO DE FERRAMENTAS MCP (${MCP_TOOLS.length}) ===`);
    for (const tool of MCP_TOOLS) {
      console.log(`[MCP TOOL] ${tool.name}: ${tool.description}`);
    }
  });
});
