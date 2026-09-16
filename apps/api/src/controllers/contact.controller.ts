import type { FastifyReply, FastifyRequest } from "fastify";
import { contactSubmitSchema } from "../validations/contact.schema.js";
import type { ContactService } from "../services/contact.service.js";
import { sendHandlerError } from "../lib/http.js";
import { createAppError } from "../lib/errors.js";

export function createContactHandlers(contactService: ContactService) {
  return {
    submit: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = contactSubmitSchema.safeParse(request.body);
        if (!parsed.success) {
          throw createAppError(400, "Invalid form data", "VALIDATION_ERROR");
        }
        const result = await contactService.submit(parsed.data);
        return reply.status(201).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not send message");
      }
    },
  };
}

export type ContactHandlers = ReturnType<typeof createContactHandlers>;
