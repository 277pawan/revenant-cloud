import { z } from "zod";

export const evidenceIdParamSchema = z.object({
  id: z.string().uuid(),
});
