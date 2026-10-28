import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwtToken } from '../src/auth/jwt.js';
import { config } from '../src/config/env.js';

describe('T01 - Verificação e Validação Criptográfica de JWT (E1.3-d)', () => {
  const secretKey = new TextEncoder().encode(config.jwtSecret);

  it('deve aceitar token JWT válido emitido pelo Auth com sub canônico', async () => {
    const token = await new SignJWT({
      email: 'operador@jpros.local',
      name: 'Operador Teste',
      role: 'ADMIN',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-canonic-uuid-001')
      .setIssuer(config.jwtIss)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(true);
    expect(result.user?.id).toBe('usr-canonic-uuid-001');
    expect(result.user?.email).toBe('operador@jpros.local');
    expect(result.user?.name).toBe('Operador Teste');
    expect(result.user?.role).toBe('ADMIN');
  });

  it('deve rejeitar token adulterado (assinatura inválida)', async () => {
    const wrongSecret = new TextEncoder().encode('wrong_secret_at_least_32_characters_long_for_test');
    const token = await new SignJWT({ email: 'fake@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-fake-001')
      .setIssuer(config.jwtIss)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('deve rejeitar token expirado', async () => {
    const token = await new SignJWT({ email: 'expired@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-exp-001')
      .setIssuer(config.jwtIss)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expir|expired|claim/i);
  });

  it('deve rejeitar token sem claim exp', async () => {
    const token = await new SignJWT({ email: 'noexp@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-noexp-001')
      .setIssuer(config.jwtIss)
      .setIssuedAt()
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/claim "exp"/i);
  });

  it('deve rejeitar token sem claim sub canônica', async () => {
    const token = await new SignJWT({ email: 'nosub@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.jwtIss)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/claim "sub"/i);
  });

  it('deve rejeitar token com emissor (iss) incorreto', async () => {
    const token = await new SignJWT({ email: 'badiss@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-badiss-001')
      .setIssuer('malicious-issuer')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
  });

  it('deve rejeitar algoritmo inesperado ou desprotegido (ex: none)', async () => {
    // JWT com alg none
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'usr-none-001',
        iss: config.jwtIss,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    const result = await verifyJwtToken(noneToken);
    expect(result.valid).toBe(false);
  });

  it('deve rejeitar token com nbf no futuro', async () => {
    const token = await new SignJWT({ email: 'future@jpros.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr-future-001')
      .setIssuer(config.jwtIss)
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) + 3600)
      .setExpirationTime('2h')
      .sign(secretKey);

    const result = await verifyJwtToken(token);
    expect(result.valid).toBe(false);
  });
});
