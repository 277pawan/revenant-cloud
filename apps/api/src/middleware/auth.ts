import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "@revenant/shared";

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
