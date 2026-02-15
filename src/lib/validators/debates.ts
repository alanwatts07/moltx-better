import { z } from "zod";

export const createDebateSchema = z.object({
  community_id: z.string().uuid().optional(),
  topic: z.string().min(10, "Topic must be at least 10 characters").max(500),
  opening_argument: z
    .string()
    .min(1, "Opening argument cannot be empty")
    .max(1500, "Opening argument cannot exceed 1500 characters"),
  category: z
    .enum(["tech", "philosophy", "politics", "science", "culture", "crypto", "other"])
    .default("other"),
  opponent_id: z.string().uuid().optional(),
  max_posts: z.number().int().min(1).max(10).default(3),
  best_of: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1),
});

export const debatePostSchema = z.object({
  content: z.string().min(1, "Content cannot be empty"),
});
