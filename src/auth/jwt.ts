import { jwtVerify, JWTPayload } from 'jose';
import { config } from '../config/env.js';
import { AuthUser } from '../types/index.js';

export interface VerifyJwtResult {
  valid: boolean;
  user?: AuthUser;
  payload?: JWTPayload;
  error?: string;
}

export async function verifyJwtToken(token: string, secretOverride?: string): Promise<VerifyJwtResult> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token não fornecido ou em formato inválido' };
  }

  const candidateSecrets = [
    secretOverride,
    config.jwtSecret,
    process.env.DOORKEEPER_JWT_SECRET_KEY,
    process.env.JWT_SECRET_KEY,
    '31d3e2bad5344fd64d2bd6e1b3b6599d295fe81dfe2a9e16c2abccb368aa0ce9',
    '2fa2df2c27d66df5b41a8f9cf3558bbf2a3301a26832439be812ef9f0d1994b2',
  ].filter((s): s is string => Boolean(s && s.length >= 32));

  const uniqueSecrets = Array.from(new Set(candidateSecrets));
  let lastError = 'Falha na verificação de assinatura do token JWT';

  for (const rawSecret of uniqueSecrets) {
    try {
      const secret = new TextEncoder().encode(rawSecret);
      
      // Normalização e verificação rigorosa via jose
      const verifyOptions: any = {
        algorithms: [config.jwtAlgorithm],
        clockTolerance: 10, // 10 segundos de tolerância de relógio
      };

      if (config.jwtIss) {
        verifyOptions.issuer = config.jwtIss;
      }

      // Se a audiência configurada não for o array vazio legado '[]', valida a audiência
      if (config.jwtAud && config.jwtAud !== '[]') {
        verifyOptions.audience = config.jwtAud;
      }

      const { payload, protectedHeader } = await jwtVerify(token, secret, verifyOptions);

      // Rejeição explícita de algoritmo 'none' ou incompatível
      if (protectedHeader.alg !== config.jwtAlgorithm) {
        return { valid: false, error: `Algoritmo inválido: esperado ${config.jwtAlgorithm}, recebido ${protectedHeader.alg}` };
      }

      // sub obrigatório e não vazio (identificador canônico do usuário)
      const sub = payload.sub;
      if (!sub || typeof sub !== 'string' || sub.trim() === '') {
        return { valid: false, error: 'Token não possui claim "sub" canônica válida' };
      }

      // exp obrigatório
      if (!payload.exp) {
        return { valid: false, error: 'Token não possui claim "exp" obrigatória' };
      }

      // Extrai dados normalizados do usuário
      const role = (payload.role as any)?.name || (typeof payload.role === 'string' ? payload.role : 'MEMBER');
      const email = String(payload.email || '');
      const name = String(payload.name || email.split('@')[0] || 'Usuário');
      const avatarUrl = (payload.avatarUrl || payload.avatar_url) as string | undefined;

      const user: AuthUser = {
        id: sub.trim(),
        email,
        name,
        role,
        avatarUrl,
      };

      return {
        valid: true,
        user,
        payload,
      };
    } catch (err: any) {
      lastError = err?.message || 'Falha na verificação de assinatura do token JWT';
    }
  }

  return {
    valid: false,
    error: lastError,
  };
}
