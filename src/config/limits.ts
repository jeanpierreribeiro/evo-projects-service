/**
 * Limites operacionais de entrada e dados (E1.5-b, E3.1-c, E3.1-d / Seção 4.2)
 * Centralizados para espelhamento com frontend e validação estrita no backend.
 */
export const LIMITS = {
  TITLE_MAX_LENGTH: 200,
  DESCRIPTION_MAX_LENGTH: 50000,
  COMMENT_MAX_LENGTH: 10000,
  BATCH_OPERATION_MAX_ITEMS: 100,
  TAG_MAX_LENGTH: 50,
  TAGS_MAX_COUNT: 50,
  NAME_MAX_LENGTH: 200,
  ESTIMATED_HOURS_MAX: 10000,
  ESTIMATED_MINUTES_MAX: 600000,
  DURATION_MINUTES_MAX: 10000,

  // Paginação por cursor (E3.1-c)
  PAGINATION_DEFAULT_LIMIT: 50,
  PAGINATION_MAX_LIMIT: 100,

  // Anexos e armazenamento (E3.7)
  ATTACHMENT_MAX_SIZE_BYTES: 20 * 1024 * 1024, // 20 MiB
  ATTACHMENT_MAX_WORKSPACE_BYTES: 10 * 1024 * 1024 * 1024, // 10 GiB
} as const;
