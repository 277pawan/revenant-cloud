import { eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { AuthUser, UserRole } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { organizations, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { clearSessionCookie, setSessionCookie } from "../lib/session.js";
import { AppError } from "../lib/errors.js";
import type { Env } from "../config/env.js";
import type { LoginInput, RegisterInput } from "../validations/auth.schema.js";

export class AuthService {
  constructor(
    private db: Database,
    private env: Env
  ) {}

  async register(input: RegisterInput): Promise<{ token: string; user: AuthUser }> {
    if (!this.env.ALLOW_OPEN_REGISTRATION) {
      throw new AppError(
        403,
        "Registration is disabled. Ask an admin for an invite.",
        "REGISTRATION_DISABLED"
      );
    }

    const passwordHash = await hashPassword(input.password);

    try {
      const [org] = await this.db
        .insert(organizations)
        .values({ name: input.organizationName })
        .returning();

      const [user] = await this.db
        .insert(users)
        .values({
          organizationId: org.id,
          email: input.email.toLowerCase(),
          passwordHash,
          role: "admin",
        })
        .returning();

      return {
        token: "", // filled by controller via jwtSign
        user: {
          id: user.id,
          email: user.email,
          role: "admin",
          organizationId: org.id,
          organizationName: org.name,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new AppError(409, "Email already registered", "CONFLICT");
      }
      throw err;
    }
  }

  async login(input: LoginInput): Promise<AuthUser> {
    const rows = await this.db
      .select({
        user: users,
        org: organizations,
      })
      .from(users)
      .innerJoin(organizations, eq(users.organizationId, organizations.id))
      .where(eq(users.email, input.email.toLowerCase()))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    const valid = await verifyPassword(input.password, row.user.passwordHash);
    if (!valid) {
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    return {
      id: row.user.id,
      email: row.user.email,
      role: row.user.role as UserRole,
      organizationId: row.org.id,
      organizationName: row.org.name,
    };
  }

  async issueSession(
    reply: FastifyReply,
    payload: AuthUser
  ): Promise<{ token: string; user: AuthUser }> {
    const token = await reply.jwtSign(payload, { expiresIn: this.env.JWT_EXPIRES_IN });
    setSessionCookie(reply, token, this.env);
    return { token, user: payload };
  }

  logout(reply: FastifyReply): { ok: boolean } {
    clearSessionCookie(reply, this.env);
    return { ok: true };
  }
}
