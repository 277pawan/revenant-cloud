import { and, count, desc, eq, sql } from "drizzle-orm";
import type { DatabaseResource, Paginated } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databaseCredentials, databases, validationPlans } from "../db/schema.js";
import { encryptSecret } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import type {
  CreateDatabaseInput,
  UpdateDatabaseInput,
} from "../validations/databases.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toResource(
  row: typeof databases.$inferSelect,
  hasCredentials: boolean,
  hasValidationPlan: boolean
): DatabaseResource {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    databaseName: row.databaseName,
    username: row.username,
    sslMode: row.sslMode,
    region: row.region,
    description: row.description,
    hasCredentials,
    hasValidationPlan,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DatabasesService {
  constructor(
    private db: Database,
    private masterKey: string
  ) {}

  async list(
    organizationId: string,
    pagination: PaginationQueryInput
  ): Promise<Paginated<DatabaseResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(databases)
      .where(eq(databases.organizationId, organizationId));

    const total = Number(totalRow?.value ?? 0);

    const rows = await this.db
      .select({
        db: databases,
        hasCredentials: sql<boolean>`(${databaseCredentials.id} is not null)`,
        hasValidationPlan: sql<boolean>`(${validationPlans.id} is not null)`,
      })
      .from(databases)
      .leftJoin(
        databaseCredentials,
        eq(databaseCredentials.databaseId, databases.id)
      )
      .leftJoin(validationPlans, eq(validationPlans.databaseId, databases.id))
      .where(eq(databases.organizationId, organizationId))
      .orderBy(desc(databases.createdAt))
      .limit(pageSize)
      .offset(offset);

    return {
      data: rows.map((r) =>
        toResource(r.db, Boolean(r.hasCredentials), Boolean(r.hasValidationPlan))
      ),
      pagination: paginationMeta(total, page, pageSize),
    };
  }

  async getById(organizationId: string, id: string): Promise<DatabaseResource> {
    const rows = await this.db
      .select({
        db: databases,
        hasCredentials: sql<boolean>`(${databaseCredentials.id} is not null)`,
        hasValidationPlan: sql<boolean>`(${validationPlans.id} is not null)`,
      })
      .from(databases)
      .leftJoin(
        databaseCredentials,
        eq(databaseCredentials.databaseId, databases.id)
      )
      .leftJoin(validationPlans, eq(validationPlans.databaseId, databases.id))
      .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new AppError(404, "Database not found", "NOT_FOUND");
    }
    return toResource(
      row.db,
      Boolean(row.hasCredentials),
      Boolean(row.hasValidationPlan)
    );
  }

  async create(
    organizationId: string,
    input: CreateDatabaseInput
  ): Promise<DatabaseResource> {
    const [row] = await this.db
      .insert(databases)
      .values({
        organizationId,
        name: input.name,
        engine: input.engine ?? "postgres",
        host: input.host,
        port: input.port ?? 5432,
        databaseName: input.databaseName,
        username: input.username,
        sslMode: input.sslMode ?? "require",
        region: input.region,
        description: input.description,
      })
      .returning();

    let hasCredentials = false;
    if (input.password) {
      await this.upsertCredential(organizationId, row.id, input.password);
      hasCredentials = true;
    }

    return toResource(row, hasCredentials, false);
  }

  async update(
    organizationId: string,
    id: string,
    input: UpdateDatabaseInput
  ): Promise<DatabaseResource> {
    const existing = await this.db
      .select()
      .from(databases)
      .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
      .limit(1);

    if (!existing[0]) {
      throw new AppError(404, "Database not found", "NOT_FOUND");
    }

    const patch: Partial<typeof databases.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.engine !== undefined) patch.engine = input.engine;
    if (input.host !== undefined) patch.host = input.host;
    if (input.port !== undefined) patch.port = input.port;
    if (input.databaseName !== undefined) patch.databaseName = input.databaseName;
    if (input.username !== undefined) patch.username = input.username;
    if (input.sslMode !== undefined) patch.sslMode = input.sslMode;
    if (input.region !== undefined) patch.region = input.region;
    if (input.description !== undefined) patch.description = input.description;

    const [row] = await this.db
      .update(databases)
      .set(patch)
      .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
      .returning();

    if (input.password !== undefined) {
      if (input.password === "") {
        await this.db
          .delete(databaseCredentials)
          .where(
            and(
              eq(databaseCredentials.databaseId, id),
              eq(databaseCredentials.organizationId, organizationId)
            )
          );
      } else {
        await this.upsertCredential(organizationId, id, input.password);
      }
    }

    return this.getById(organizationId, row.id);
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(databases)
      .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
      .returning({ id: databases.id });

    if (!deleted[0]) {
      throw new AppError(404, "Database not found", "NOT_FOUND");
    }
  }

  private async upsertCredential(
    organizationId: string,
    databaseId: string,
    plainPassword: string
  ): Promise<void> {
    const encrypted = encryptSecret(plainPassword, this.masterKey);
    const existing = await this.db
      .select({ id: databaseCredentials.id })
      .from(databaseCredentials)
      .where(eq(databaseCredentials.databaseId, databaseId))
      .limit(1);

    if (existing[0]) {
      await this.db
        .update(databaseCredentials)
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: 1,
          updatedAt: new Date(),
        })
        .where(eq(databaseCredentials.id, existing[0].id));
    } else {
      await this.db.insert(databaseCredentials).values({
        organizationId,
        databaseId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: 1,
      });
    }
  }
}
