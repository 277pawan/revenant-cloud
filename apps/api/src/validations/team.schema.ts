import { z } from "zod";

export const inviteTeamMemberSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "executor", "viewer"]),
});

export const updateTeamMemberSchema = z.object({
  role: z.enum(["admin", "executor", "viewer"]),
});

export const teamMemberIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type InviteTeamMemberInput = z.infer<typeof inviteTeamMemberSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
