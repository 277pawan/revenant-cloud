import type { FastifyReply, FastifyRequest } from "fastify";

import {
  resolveRedisSnapshotRetentionHours,
  type RedisResource,
} from "@revenant/shared";

import type { Database } from "../db/index.js";
import { sendHandlerError } from "../lib/http.js";
import { getOrganizationPlan } from "../lib/plan-limits.js";
import {
  createRedisResource,
  deleteRedisResource,
  getRedisResource,
  listRedisResources,
  testRedisConnection,
  updateRedisResource,
  assertRedisResourceAllowed,
  assertSnapshotStorageAllowed,
} from "../services/redis-resources.service.js";
import {
  assertProofQuota,
  getRedisProofOverview,
  startRedisProof,
  deleteRedisSnapshot,
} from "../services/redis-snapshots.service.js";
import {
  createRedisResourceSchema,
  redisIdParamSchema,
  redisSnapshotIdParamSchema,
  startRedisProofSchema,
  testRedisUrlSchema,
  updateRedisResourceSchema,
} from "../validations/redis.schema.js";

export interface RedisHandlersDeps {
  db: Database;
  masterKey: string;
  /** Disable outbound Redis probes in hardened deployments */
  redisProbeEnabled: boolean;
}

export function createRedisHandlers(deps: RedisHandlersDeps) {
  const { db, masterKey } = deps;

  return {
    /**
     * POST /redis/test — paste a URL, get an answer.
     *
     * This is deliberately NOT persisted. It is the cheapest possible way for
     * someone to find out whether Revenant can see their Redis before they
     * create anything.
     */
    test: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = testRedisUrlSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid Redis URL",
          code: "VALIDATION_ERROR",
        });
      }
      if (!deps.redisProbeEnabled) {
        return reply.status(503).send({
          error:
            "Direct Redis probing is disabled on this deployment. Use the Revenant agent to verify from inside your network.",
          code: "PROBE_DISABLED",
        });
      }

      const result = await testRedisConnection(body.data.url);
      // 200 even when unreachable — "we can't reach it" is a valid answer,
      // not a failed request. The client renders it as guidance, not an error.
      return { test: result };
    },

    list: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resources = await listRedisResources(db, request.user.organizationId);
        return { resources };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list Redis resources");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createRedisResourceSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid Redis resource",
          code: "VALIDATION_ERROR",
          details: body.error.flatten(),
        });
      }

      try {
        const plan = await getOrganizationPlan(db, request.user.organizationId);
        await assertRedisResourceAllowed(db, request.user.organizationId, plan);

        if (body.data.snapshotEnabled) {
          assertSnapshotStorageAllowed(plan);
        }

        const resource = await createRedisResource(
          db,
          {
            organizationId: request.user.organizationId,
            userId: request.user.id,
            name: body.data.name,
            url: body.data.url,
            databaseId: body.data.databaseId ?? null,
            snapshotEnabled: body.data.snapshotEnabled,
            snapshotRetentionHours: body.data.snapshotRetentionHours ?? null,
            // The service clamps the TTL against this. Never trust the
            // requested value on its own.
            plan,
          },
          masterKey
        );

        return reply.status(201).send({ resource });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create Redis resource");
      }
    },

    get: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid Redis id", code: "VALIDATION_ERROR" });
      }
      try {
        const resource = await getRedisResource(
          db,
          request.user.organizationId,
          params.data.id
        );
        return { resource };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load Redis resource");
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid Redis id", code: "VALIDATION_ERROR" });
      }
      const body = updateRedisResourceSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid Redis update",
          code: "VALIDATION_ERROR",
          details: body.error.flatten(),
        });
      }

      try {
        const plan = await getOrganizationPlan(db, request.user.organizationId);
        if (body.data.snapshotEnabled === true) {
          assertSnapshotStorageAllowed(plan);
        }
        const resource: RedisResource = await updateRedisResource(
          db,
          {
            organizationId: request.user.organizationId,
            id: params.data.id,
            plan,
            changes: body.data,
          },
          masterKey
        );
        return { resource };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update Redis resource");
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid Redis id", code: "VALIDATION_ERROR" });
      }
      try {
        await deleteRedisResource(db, request.user.organizationId, params.data.id);
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete Redis resource");
      }
    },

    /**
     * POST /redis/:id/proofs — open a restore proof.
     *
     * Returns the storage key and expiry ONLY when the customer has opted in
     * to storage. With storage off, snapshotId/storageKey/expiresAt are null
     * and the proof still runs and still counts against quota.
     */
    startProof: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid Redis id", code: "VALIDATION_ERROR" });
      }
      const body = startRedisProofSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid proof request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten(),
        });
      }

      try {
        const plan = await getOrganizationPlan(db, request.user.organizationId);
        await assertProofQuota(db, request.user.organizationId, plan);

        const resource = await getRedisResource(
          db,
          request.user.organizationId,
          params.data.id
        );

        const retentionHours = resolveRedisSnapshotRetentionHours(
          plan,
          body.data.retentionHours ?? resource.snapshotRetentionHours
        );

        const started = await startRedisProof(db, {
          organizationId: request.user.organizationId,
          redisResourceId: params.data.id,
          triggeredByUserId: request.user.id,
          retentionHours,
        });

        return reply.status(202).send({ proof: started });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to start Redis proof");
      }
    },

    listProofs: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid Redis id", code: "VALIDATION_ERROR" });
      }
      try {
        const overview = await getRedisProofOverview(
          db,
          request.user.organizationId,
          params.data.id
        );
        // proofsUsedThisMonth is resolved server-side: the proofs list is
        // capped at 50, so summing it in the client would undercount.
        return overview;
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list Redis proofs");
      }
    },

    deleteSnapshot: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = redisSnapshotIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid snapshot id", code: "VALIDATION_ERROR" });
      }
      try {
        await deleteRedisSnapshot(db, request.user.organizationId, params.data.id);
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete Redis snapshot");
      }
    },
  };
}

export type RedisHandlers = ReturnType<typeof createRedisHandlers>;