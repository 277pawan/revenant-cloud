import { z } from "zod";

/** Query params for every list GET — page starts at 1 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQueryInput = z.infer<typeof paginationQuerySchema>;

export function paginationMeta(total: number, page: number, pageSize: number) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function paginationOffset(page: number, pageSize: number) {
  return (page - 1) * pageSize;
}
