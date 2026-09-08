import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { organizations, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { clearSessionCookie, setSessionCookie } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import type { Env } from "../config/env.js";
import type { AuthUser } from "@revenant/shared";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  organizationName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

async function issueSession(reply: FastifyReply, env: Env, payload: AuthUser) {
  const token = await reply.jwtSign(payload, { expiresIn: env.JWT_EXPIRES_IN });
  setSessionCookie(reply, token, env);
  return { token, user: payload };
}

export async function authRoutes(app: FastifyInstance, db: Database, env: Env) {
  app.post("/api/v1/auth/register", async (request, reply) => {
    if (!env.ALLOW_OPEN_REGISTRATION) {
      return reply.status(403).send({
        error: "Registration is disabled. Ask an admin for an invite.",
        code: "REGISTRATION_DISABLED",
      });
    }

    const body = registerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid request", code: "VALIDATION_ERROR" });
    }

    const { organizationName, email, password } = body.data;
    const passwordHash = await hashPassword(password);

    try {
      const [org] = await db
        .insert(organizations)
        .values({ name: organizationName })
        .returning();

      const [user] = await db
        .insert(users)
        .values({
          organizationId: org.id,
          email: email.toLowerCase(),
          passwordHash,
          role: "admin",
        })
        .returning();

      const payload = {
        id: user.id,
        email: user.email,
        role: user.role as "admin",
        organizationId: org.id,
        organizationName: org.name,
      };

      return issueSession(reply, env, payload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("unique") || message.includes("duplicate")) {
        return reply.status(409).send({ error: "Email already registered", code: "CONFLICT" });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Registration failed", code: "INTERNAL" });
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid request", code: "VALIDATION_ERROR" });
    }

    const { email, password } = body.data;
    const rows = await db
      .select({
        user: users,
        org: organizations,
      })
      .from(users)
      .innerJoin(organizations, eq(users.organizationId, organizations.id))
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return reply.status(401).send({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    }

    const valid = await verifyPassword(password, row.user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    }

    const payload = {
      id: row.user.id,
      email: row.user.email,
      role: row.user.role as "admin" | "executor" | "viewer",
      organizationId: row.org.id,
      organizationName: row.org.name,
    };

    return issueSession(reply, env, payload);
  });

  app.post("/api/v1/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply, env);
    return { ok: true };
  });

  app.get("/api/v1/me", { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
  });
}
