import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const envSchema = z.object({
  PORT: z.coerce.number().default(3003),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  
  // JWT Configuration (Auth contract E1.3-c / T17)
  JWT_SECRET_KEY: z.string().min(32, 'JWT_SECRET_KEY deve ter no mínimo 32 caracteres para HS256'),
  JWT_ALGORITHM: z.string().default('HS256'),
  JWT_ISS: z.string().default('evo-auth-service'),
  JWT_AUD: z.string().default('[]'),
  
  // Auth service endpoint for live validation and revocation
  EVO_AUTH_SERVICE_URL: z.string().url().default('http://localhost:3011'),
  AUTH_CACHE_TTL_SECONDS: z.coerce.number().min(0).max(60).default(60),

  // CORS & Security
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3030'),

  // Redis & Public Sharing (Phase 2 - E2.1-c)
  REDIS_URL: z.string().default('redis://:evoai_redis_pass@localhost:56381'),
  SHARE_DEFAULT_EXPIRATION_DAYS: z.coerce.number().min(1).max(365).default(14),
  SHARE_MAX_EXPIRATION_DAYS: z.coerce.number().min(1).max(365).default(30),
  SHARE_SESSION_TTL_MINUTES: z.coerce.number().min(5).max(1440).default(60),
  SHARE_PIN_PEPPER: z.string().min(16).default('jpros-share-pin-pepper-secret-2026-secure'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

  // Feature flags (default false per section 14.1 item 7)
  PROJECTS_MCP_ENABLED: z.string().transform((v) => v === 'true' || v === '1').default('false'),
  PROJECTS_SHARING_ENABLED: z.string().transform((v) => v === 'true' || v === '1').default('false'),
  PROJECTS_UPLOADS_ENABLED: z.string().transform((v) => v === 'true' || v === '1').default('false'),
});

export function validateEnv(raw: Record<string, any>) {
  return envSchema.parse(raw);
}

const parsed = envSchema.safeParse({
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || process.env.DOORKEEPER_JWT_SECRET_KEY,
  JWT_ALGORITHM: process.env.JWT_ALGORITHM || process.env.DOORKEEPER_JWT_ALGORITHM || 'HS256',
  JWT_ISS: process.env.JWT_ISS || process.env.DOORKEEPER_JWT_ISS || 'evo-auth-service',
  JWT_AUD: process.env.JWT_AUD || process.env.DOORKEEPER_JWT_AUD || '[]',
  EVO_AUTH_SERVICE_URL: process.env.EVO_AUTH_SERVICE_URL,
  AUTH_CACHE_TTL_SECONDS: process.env.AUTH_CACHE_TTL_SECONDS,
  CORS_ORIGINS: process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3030',
  REDIS_URL: process.env.REDIS_URL,
  SHARE_DEFAULT_EXPIRATION_DAYS: process.env.SHARE_DEFAULT_EXPIRATION_DAYS,
  SHARE_MAX_EXPIRATION_DAYS: process.env.SHARE_MAX_EXPIRATION_DAYS,
  SHARE_SESSION_TTL_MINUTES: process.env.SHARE_SESSION_TTL_MINUTES,
  SHARE_PIN_PEPPER: process.env.SHARE_PIN_PEPPER,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  PROJECTS_MCP_ENABLED: process.env.PROJECTS_MCP_ENABLED,
  PROJECTS_SHARING_ENABLED: process.env.PROJECTS_SHARING_ENABLED,
  PROJECTS_UPLOADS_ENABLED: process.env.PROJECTS_UPLOADS_ENABLED,
});

if (!parsed.success) {
  console.error('❌ Falha na validação de configuração do ambiente (env):', parsed.error.format());
  throw new Error('Configuração de ambiente inválida para evo-projects-service');
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET_KEY,
  jwtAlgorithm: env.JWT_ALGORITHM.toUpperCase(),
  jwtIss: env.JWT_ISS,
  jwtAud: env.JWT_AUD,
  evoAuthUrl: env.EVO_AUTH_SERVICE_URL.replace(/\/$/, ''),
  authCacheTtlSeconds: env.AUTH_CACHE_TTL_SECONDS,
  corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  redisUrl: env.REDIS_URL,
  shareDefaultExpirationDays: env.SHARE_DEFAULT_EXPIRATION_DAYS,
  shareMaxExpirationDays: env.SHARE_MAX_EXPIRATION_DAYS,
  shareSessionTtlMinutes: env.SHARE_SESSION_TTL_MINUTES,
  sharePinPepper: env.SHARE_PIN_PEPPER,
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ''),
  projectsMcpEnabled: env.PROJECTS_MCP_ENABLED,
  projectsSharingEnabled: env.PROJECTS_SHARING_ENABLED,
  projectsUploadsEnabled: env.PROJECTS_UPLOADS_ENABLED,
};
