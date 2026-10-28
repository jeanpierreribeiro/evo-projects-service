import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Utilitários criptográficos seguros para compartilhamento público de tarefas (E2.1-d).
 * 
 * Invariantes de segurança:
 * 1. Tokens de alta entropia (32 bytes) utilizam SHA-256 (não utilizam hash de senha lento).
 * 2. PINs numéricos de 6 dígitos são gerados com crypto.randomInt e protegidos por scrypt com sal aleatório e pepper separado do banco.
 * 3. Todas as comparações de hashes sensíveis utilizam timingSafeEqual para mitigar ataques de temporização.
 * 4. Tokens e PINs brutos NUNCA são persistidos nem logados.
 */

/**
 * Gera um token criptograficamente seguro de 32 bytes em formato base64url.
 */
export function generateShareToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Calcula o hash SHA-256 de um token para persistência ou busca segura no banco.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Gera um PIN numérico de 6 dígitos com preenchimento de zeros à esquerda.
 */
export function generateSharePin(): string {
  const pinNumber = crypto.randomInt(0, 1_000_000);
  return pinNumber.toString().padStart(6, '0');
}

/**
 * Gera o hash criptográfico do PIN utilizando scrypt, sal aleatório de 16 bytes e pepper do ambiente.
 * Formato persistido: "saltHex:derivedKeyHex"
 */
export async function hashPin(pin: string, customSalt?: string): Promise<string> {
  const salt = customSalt || crypto.randomBytes(16).toString('hex');
  const pepper = config.sharePinPepper;
  const combined = `${pin}:${pepper}`;

  // scrypt com custo adequado: N=16384, r=8, p=1, keylen=32
  const derivedKey = crypto.scryptSync(combined, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });

  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Valida um PIN contra o hash armazenado de forma imune a timing attacks.
 */
export async function verifyPin(candidatePin: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;

    const [salt, expectedKeyHex] = parts;
    const expectedKey = Buffer.from(expectedKeyHex, 'hex');
    const pepper = config.sharePinPepper;
    const combined = `${candidatePin}:${pepper}`;

    const candidateKey = crypto.scryptSync(combined, salt, expectedKey.length, {
      N: 16384,
      r: 8,
      p: 1,
    });

    if (candidateKey.length !== expectedKey.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateKey, expectedKey);
  } catch (err) {
    return false;
  }
}

/**
 * Gera um token de sessão opaco para o cookie `task_share_session`.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Calcula o hash SHA-256 do verificador de sessão para busca segura.
 */
export function hashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken, 'utf8').digest('hex');
}
