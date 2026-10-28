import { LIMITS } from '../config/limits.js';

export interface CursorPaginationOptions {
  cursor?: string;
  limit?: number;
}

export interface PaginationResult<T> {
  data: T[];
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

export function parsePaginationParams(query: { cursor?: string; limit?: string | number } = {}): {
  cursor?: string;
  limit: number;
} {
  const parsedLimit = typeof query.limit === 'string' ? parseInt(query.limit, 10) : query.limit;
  const limit = Math.min(
    Math.max(parsedLimit && !isNaN(parsedLimit) ? parsedLimit : LIMITS.PAGINATION_DEFAULT_LIMIT, 1),
    LIMITS.PAGINATION_MAX_LIMIT
  );

  return {
    cursor: query.cursor && typeof query.cursor === 'string' && query.cursor.trim() ? query.cursor.trim() : undefined,
    limit,
  };
}

export function buildCursorResponse<T extends Record<string, any>>(
  items: T[],
  limit: number,
  idKey: keyof T = 'id' as keyof T
): PaginationResult<T> {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const lastItem = hasMore && data.length > 0 ? data[data.length - 1] : null;
  const nextCursor = lastItem
    ? ((lastItem[idKey] ?? lastItem.id ?? lastItem.taskId) as string)
    : null;

  return {
    data,
    pagination: {
      cursor: nextCursor ?? null,
      hasMore,
      limit,
    },
  };
}
