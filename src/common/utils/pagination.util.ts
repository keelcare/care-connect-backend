/**
 * Optional pagination for list endpoints.
 *
 * Backward-compatible: when no pagination is supplied the query is unbounded
 * (existing behaviour). When `page`/`limit` are provided, `paginate()` returns
 * Prisma `skip`/`take` clauses. `limit` is clamped to a sane maximum so a client
 * cannot request an unbounded page.
 */
export interface Pagination {
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function paginate(pagination?: Pagination): { skip?: number; take?: number } {
  if (!pagination || (pagination.page == null && pagination.limit == null)) {
    return {};
  }
  const page = Math.max(1, Math.floor(Number(pagination.page) || 1));
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(Number(pagination.limit) || DEFAULT_LIMIT)),
  );
  return { skip: (page - 1) * limit, take: limit };
}
