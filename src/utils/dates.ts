import { ValidationError } from '../errors/app-error.js';

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida formato YYYY-MM-DD e existência real no calendário civil (ano bissexto, dias por mês)
 */
export function parseCivilDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ValidationError(`Formato de data civil inválido: "${dateStr}". Use o formato YYYY-MM-DD.`);
  }

  const [yearStr, monthStr, dayStr] = trimmed.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (month < 1 || month > 12) {
    throw new ValidationError(`Mês inválido na data: "${dateStr}".`);
  }

  // Cria objeto Date no meio-dia UTC para evitar problemas de virada de fuso no Date-only
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ValidationError(`Data civil inexistente no calendário: "${dateStr}".`);
  }

  return parsed;
}

/**
 * Formata Date para YYYY-MM-DD civil
 */
export function formatCivilDate(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().substring(0, 10);
  }
  return date.toISOString().substring(0, 10);
}

/**
 * Obtém a data civil de hoje ("YYYY-MM-DD") no fuso especificado do workspace (I5)
 */
export function getWorkspaceTodayCivilDate(timezone: string = 'America/Sao_Paulo'): string {
  const tz = isValidIanaTimezone(timezone) ? timezone : 'America/Sao_Paulo';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Verifica se a data civil informada está vencida em relação ao "hoje" no fuso do workspace
 */
export function isOverdueCivil(dueDate: string | null | undefined, timezone: string = 'America/Sao_Paulo'): boolean {
  if (!dueDate) return false;
  const today = getWorkspaceTodayCivilDate(timezone);
  const due = typeof dueDate === 'string' ? dueDate.substring(0, 10) : '';
  return due < today;
}
