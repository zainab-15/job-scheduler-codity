import type { PaginatedResult } from '@scheduler/shared';

export const paginationQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

/** Uniform list-response envelope (§6) across every paginated resource. */
export function paginationEnvelope<T>(result: PaginatedResult<T>) {
  return {
    data: result.data,
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      has_more: result.offset + result.data.length < result.total,
    },
  };
}
