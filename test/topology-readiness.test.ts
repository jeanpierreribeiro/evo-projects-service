import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import prisma from '../src/db/prisma.js';

vi.mock('../src/db/prisma.js', () => ({
  default: {
    $queryRaw: vi.fn(),
  },
}));

describe('T17 - Topologia, Readiness e Verificação de Configuração (E1.8)', () => {
  const app = buildApp();

  describe('Validação estrita de configuração no boot', () => {
    it('deve FALHAR e impedir a subida se JWT_SECRET_KEY estiver ausente', () => {
      expect(() => {
        validateEnv({
          PORT: '3003',
          HOST: '0.0.0.0',
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/db',
          // JWT_SECRET_KEY omitido!
        });
      }).toThrow();
    });

    it('deve FALHAR se JWT_SECRET_KEY tiver menos de 32 caracteres', () => {
      expect(() => {
        validateEnv({
          PORT: '3003',
          HOST: '0.0.0.0',
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/db',
          JWT_SECRET_KEY: 'short_key_123',
        });
      }).toThrow(/32 caracteres/i);
    });
  });

  describe('Endpoints /health e /ready', () => {
    it('/health deve ser público e retornar status 200 com informações de serviço', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('evo-projects-service');
      expect(body.timestamp).toBeDefined();

      // Cabeçalhos de segurança (E1.8-a)
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('/ready deve responder 200 quando o banco de dados estiver acessível', async () => {
      (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);

      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ready');
      expect(res.json().database).toBe('connected');
    });

    it('/ready deve responder 503 quando o banco de dados estiver inacessível', async () => {
      (prisma.$queryRaw as any).mockRejectedValue(new Error('Connection refused'));

      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('not_ready');
      expect(res.json().database).toBe('disconnected');
    });
  });

  describe('Política de CORS explícita (E1.2-e / E1.8-e)', () => {
    it('deve permitir origens explicitamente listadas', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:5173',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('deve recusar origens desconhecidas não autorizadas', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://malicious-website.com',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
