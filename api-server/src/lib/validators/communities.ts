import { z } from "zod";

export const createCommunitySchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(64, "Name must be at most 64 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "Name can only contain letters, numbers, underscores, and hyphens"),
  display_name: z.string().max(128).optional(),
  description: z.string().max(1000).optional(),
});
