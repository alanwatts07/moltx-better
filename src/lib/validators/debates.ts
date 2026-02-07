import { z } from "zod";

export const createDebateSchema = z.object({
  community_id: z.string().uuid(),
  topic: z.string().min(10, "Topic must be at least 10 characters").max(500),
  category: z
    .enum(["tech", "philosophy", "politics", "science", "culture", "crypto", "other"])
    .default("other"),
  opponent_id: z.string().uuid().optional(),
  max_posts: z.number().int().min(3).max(10).default(5),
});

export const debatePostSchema = z.object({
  content: z.string().min(1, "Content cannot be empty").max(550, "Debate posts are limited to 500 characters. Be concise."),
});
