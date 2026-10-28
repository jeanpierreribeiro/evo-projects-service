import { describe, it, expect } from 'vitest';
import {
  generateShareToken,
  hashToken,
  generateSharePin,
  hashPin,
  verifyPin,
  generateSessionToken,
  hashSessionToken,
} from '../src/share/crypto.js';

describe('Share Crypto Utilities (E2.1-d)', () => {
  it('should generate valid 32-byte base64url tokens and deterministic SHA-256 hashes', () => {
    const token = generateShareToken();
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(40);

    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);

    const otherToken = generateShareToken();
    expect(hashToken(otherToken)).not.toBe(hash1);
  });

  it('should generate valid 6-digit numeric PINs with zero padding', () => {
    for (let i = 0; i < 20; i++) {
      const pin = generateSharePin();
      expect(pin).toMatch(/^\d{6}$/);
      const num = parseInt(pin, 10);
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThan(1000000);
    }
  });

  it('should hash and verify PINs using scrypt, salt and pepper', async () => {
    const pin = '001234';
    const hash = await hashPin(pin);

    expect(hash).toContain(':');
    const [salt, key] = hash.split(':');
    expect(salt).toHaveLength(32); // 16 bytes hex
    expect(key).toHaveLength(64); // 32 bytes hex

    // Verify correct PIN
    const isValid = await verifyPin(pin, hash);
    expect(isValid).toBe(true);

    // Reject incorrect PIN
    const isInvalid = await verifyPin('001235', hash);
    expect(isInvalid).toBe(false);

    // Reject malformed hash
    const isMalformed = await verifyPin(pin, 'invalid-hash');
    expect(isMalformed).toBe(false);
  });

  it('should generate session tokens and deterministic hashes', () => {
    const sessionToken = generateSessionToken();
    expect(sessionToken).toBeDefined();
    expect(sessionToken.length).toBeGreaterThanOrEqual(40);

    const hash = hashSessionToken(sessionToken);
    expect(hash).toHaveLength(64);
  });
});
