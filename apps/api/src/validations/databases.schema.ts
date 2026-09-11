import { z } from "zod";
import { paginationQuerySchema } from "./pagination.schema.js";

export const databasesListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(255).optional(),
});

export type DatabasesListQueryInput = z.infer<typeof databasesListQuerySchema>;

export const createDatabaseSchema = z.object({
  name: z.string().min(1).max(255),
  engine: z.enum(["postgres"]).default("postgres"),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  databaseName: z.string().max(255).optional(),
  username: z.string().max(255).optional(),
  password: z.string().min(1).max(512).optional(),
  sslMode: z.enum(["require", "prefer", "disable"]).optional(),
  region: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
});

export const updateDatabaseSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  engine: z.enum(["postgres"]).optional(),
  host: z.string().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  databaseName: z.string().max(255).nullable().optional(),
  username: z.string().max(255).nullable().optional(),
  /** omit = unchanged; "" = clear; non-empty = re-encrypt */
  password: z.string().max(512).optional(),
  sslMode: z.enum(["require", "prefer", "disable"]).nullable().optional(),
  region: z.string().max(50).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const databaseIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseSchema>;
