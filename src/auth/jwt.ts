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

  try {
    const secret = new TextEncoder().encode(secretOverride || config.jwtSecret);
    
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
    return {
      valid: false,
      error: err?.message || 'Falha na verificação de assinatura do token JWT',
    };
  }
}
