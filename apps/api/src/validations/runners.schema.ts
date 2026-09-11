import { z } from "zod";

export const runnerIdParamSchema = z.object({
  id: z.string().uuid(),
});
