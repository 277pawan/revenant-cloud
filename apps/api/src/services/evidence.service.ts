import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { EvidenceArtifactResource, JobDetailResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, evidenceArtifacts, jobs } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toResource(
  row: typeof evidenceArtifacts.$inferSelect,
  databaseName: string
): EvidenceArtifactResource {
  return {
    id: row.id,
    jobId: row.jobId,
    databaseName,
    kind: row.kind,
    sha256: row.sha256,
    byteSize: row.byteSize,
    signedAt: row.signedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function createEvidenceService(db: Database, evidenceDir: string) {
  return {
    async archiveFromJob(organizationId: string, job: JobDetailResource) {
      if (!["pass", "fail", "error"].includes(job.status)) return;

      const existing = await db
        .select({ id: evidenceArtifacts.id })
        .from(evidenceArtifacts)
        .where(eq(evidenceArtifacts.jobId, job.id))
        .limit(1);

      if (existing[0]) return;

      const payload = JSON.stringify(
        {
          job,
          archivedAt: new Date().toISOString(),
          integrity: "sha256",
        },
        null,
        2
      );

      const sha256 = createHash("sha256").update(payload).digest("hex");
      const relKey = path.join(organizationId, `${job.id}.json`);
      const absPath = path.join(evidenceDir, relKey);

      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, payload, "utf8");

      await db.insert(evidenceArtifacts).values({
        organizationId,
        jobId: job.id,
        kind: "json",
        storageKey: relKey,
        sha256,
        byteSize: Buffer.byteLength(payload),
      });
    },

    async list(organizationId: string, pagination: PaginationQueryInput) {
      const { page, pageSize } = pagination;
      const offset = paginationOffset(page, pageSize);

      const [rows, countRow] = await Promise.all([
        db
          .select({
            artifact: evidenceArtifacts,
            databaseName: databases.name,
          })
          .from(evidenceArtifacts)
          .innerJoin(jobs, eq(jobs.id, evidenceArtifacts.jobId))
          .innerJoin(databases, eq(databases.id, jobs.databaseId))
          .where(eq(evidenceArtifacts.organizationId, organizationId))
          .orderBy(desc(evidenceArtifacts.createdAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(evidenceArtifacts)
          .where(eq(evidenceArtifacts.organizationId, organizationId)),
      ]);

      const total = countRow[0]?.count ?? 0;
      return {
        data: rows.map((r) => toResource(r.artifact, r.databaseName)),
        pagination: paginationMeta(total, page, pageSize),
      };
    },

    async getDownload(organizationId: string, id: string) {
      const rows = await db
        .select()
        .from(evidenceArtifacts)
        .where(
          and(
            eq(evidenceArtifacts.id, id),
            eq(evidenceArtifacts.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!rows[0]) {
        throw createAppError(404, "Evidence not found", "NOT_FOUND");
      }

      const absPath = path.join(evidenceDir, rows[0].storageKey);
      const body = await readFile(absPath, "utf8");
      const hash = createHash("sha256").update(body).digest("hex");

      if (hash !== rows[0].sha256) {
        throw createAppError(500, "Evidence integrity check failed", "INTEGRITY");
      }

      return { body, artifact: rows[0] };
    },
  };
}

export type EvidenceService = ReturnType<typeof createEvidenceService>;
