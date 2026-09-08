import type { FastifyReply } from "fastify";
import type { Env } from "../config/env.js";

export const SESSION_COOKIE = "revenant_session";

export function setSessionCookie(reply: FastifyReply, token: string, env: Env) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: Env) {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    secure: env.COOKIE_SECURE,
  });
}
