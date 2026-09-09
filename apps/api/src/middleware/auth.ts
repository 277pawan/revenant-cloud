import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser, Permission, UserRole } from "@revenant/shared";
import { roleHasPermission } from "@revenant/shared";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    return;
  } catch {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    }
    try {
      const decoded = await request.server.jwt.verify<AuthUser>(auth.slice(7));
      request.user = decoded;
    } catch {
      return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED" });
    }
  }
}

/** Require one of the listed roles (e.g. admin-only write). */
export function requireRoles(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({
        error: "Insufficient role for this action",
        code: "FORBIDDEN",
      });
    }
  };
}

/** Permission-based check — preferred for new routes. */
export function requirePermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const ok = permissions.every((p) => roleHasPermission(request.user.role, p));
    if (!ok) {
      return reply.status(403).send({
        error: "Insufficient permissions for this action",
        code: "FORBIDDEN",
      });
    }
  };
}
