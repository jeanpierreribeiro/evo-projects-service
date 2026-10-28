import { ValidationError } from '../errors/app-error.js';
import path from 'path';

export interface ValidatedFileResult {
  mimeType: string;
  extension: string;
  sanitizedFilename: string;
}

const ALLOWED_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

/**
 * Sanitiza o nome do arquivo para evitar Path Traversal, injeções e caracteres de controle.
 */
export function sanitizeFilename(rawFilename: string): string {
  if (!rawFilename || typeof rawFilename !== 'string') {
    return 'attachment.bin';
  }

  // Remove qualquer path (Windows ou Unix)
  const basename = path.basename(rawFilename.replace(/\\/g, '/')).trim();

  // Remove caracteres nulos e perigosos
  const clean = basename.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_');

  // Trunca para no máximo 150 caracteres preservando extensão
  if (clean.length > 150) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext).substring(0, 150 - ext.length);
    return `${base}${ext}`;
  }

  return clean || 'attachment.bin';
}

/**
 * Detecta a assinatura real de bytes do arquivo.
 */
export function detectMimeTypeFromBytes(buffer: Buffer): string | null {
  if (!buffer || buffer.length === 0) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  // GIF: GIF87a ou GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: RIFF ... WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  // PDF: %PDF
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return 'application/pdf';
  }

  // ZIP: PK\x03\x04 ou PK\x05\x06
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06)
  ) {
    return 'application/zip';
  }

  // Texto puro / CSV: UTF-8 sem bytes nulos
  let isText = true;
  const sampleSize = Math.min(buffer.length, 4096);
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    // Se contiver byte nulo ou controle não-tab/newline, não é texto puro
    if (byte === 0x00 || (byte < 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      isText = false;
      break;
    }
  }

  if (isText) {
    return 'text/plain';
  }

  return null;
}

/**
 * Validação rigorosa de arquivo (E3.7-b / T03 / T10).
 * - Detecta assinatura de bytes.
 * - Rejeita categoricamente HTML e SVG executável.
 * - Detecta e rejeita arquivos poliglotas maliciosos.
 * - Verifica correspondência entre extensão declarada e tipo real.
 */
export function validateFileBuffer(
  buffer: Buffer,
  rawFilename: string
): ValidatedFileResult {
  if (!buffer || buffer.length === 0) {
    throw new ValidationError('O arquivo enviado está vazio.');
  }

  const sanitizedFilename = sanitizeFilename(rawFilename);
  const ext = path.extname(sanitizedFilename).toLowerCase();

  if (!ALLOWED_MIME_BY_EXTENSION[ext]) {
    throw new ValidationError(
      `Extensão "${ext}" não permitida. Extensões aceitas: ${Object.keys(
        ALLOWED_MIME_BY_EXTENSION
      ).join(', ')}`
    );
  }

  // Inspeção em busca de executáveis e scripts maliciosos (HTML, SVG, PHP, etc.)
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1');
  const lowerSample = sample.toLowerCase();

  const dangerousPatterns = [
    /<script/i,
    /<html/i,
    /<!doctype\s+html/i,
    /<svg/i,
    /<\?xml/i,
    /<\?php/i,
    /javascript:/i,
    /onload\s*=/i,
    /onerror\s*=/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(lowerSample)) {
      throw new ValidationError(
        'Arquivo rejeitado por conter conteúdo executável, HTML ou SVG não seguro.'
      );
    }
  }

  // Detecta MIME type real pelos magic bytes
  const detectedMime = detectMimeTypeFromBytes(buffer);

  if (!detectedMime) {
    throw new ValidationError(
      'Não foi possível validar a assinatura de bytes do arquivo ou formato binário não reconhecido.'
    );
  }

  // Verifica se a extensão bate com o tipo real
  const expectedMime = ALLOWED_MIME_BY_EXTENSION[ext];

  // Tratamento de equivalência para text/plain vs text/csv
  const isTextMatch =
    (expectedMime === 'text/plain' || expectedMime === 'text/csv') &&
    detectedMime === 'text/plain';

  if (expectedMime !== detectedMime && !isTextMatch) {
    throw new ValidationError(
      `Extensão enganosa detectada: o arquivo possui extensão "${ext}" mas conteúdo do tipo "${detectedMime}".`
    );
  }

  const finalMime = ext === '.csv' ? 'text/csv' : detectedMime;

  return {
    mimeType: finalMime,
    extension: ext,
    sanitizedFilename,
  };
}
