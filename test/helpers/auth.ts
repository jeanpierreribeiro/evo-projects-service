import { SignJWT } from 'jose';

export interface TestJwtPayload {
  sub: string;
  email: string;
  name: string;
  role?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
}

export const TEST_JWT_SECRET = 'test_secret_must_be_at_least_32_characters_long_for_hs256';

/**
 * Gera um token JWT assinado para uso estrito em suites de teste
 */
export async function createTestJwt(
  payload: TestJwtPayload,
  secret: string = TEST_JWT_SECRET,
  expiresIn: string = '1h'
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  const jwt = new SignJWT({
    email: payload.email,
    name: payload.name,
    role: payload.role || 'operator',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(payload.iss || 'evo-auth-service')
    .setAudience(payload.aud || 'evo-projects-service')
    .setIssuedAt();

  if (payload.exp) {
    jwt.setExpirationTime(payload.exp);
  } else {
    jwt.setExpirationTime(expiresIn);
  }

  return jwt.sign(secretKey);
}
