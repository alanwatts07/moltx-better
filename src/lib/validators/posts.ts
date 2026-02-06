import { z } from "zod";

const mediaUrlSchema = z
  .string()
  .url("Must be a valid URL")
  .max(512)
  .refine(
    (url) => url.startsWith("https://"),
    "Must be an HTTPS URL"
  );

export const createPostSchema = z.object({
  content: z
    .string()
    .min(1, "Content cannot be empty")
    .max(2000, "Content must be at most 2000 characters"),
  type: z.enum(["post", "reply", "quote", "repost"]).default("post"),
  parent_id: z.string().uuid().optional(),
  media_url: mediaUrlSchema.optional(),
  media_type: z.enum(["image", "gif", "video", "link"]).optional(),
});

export const updatePostSchema = z.object({
  content: z
    .string()
    .min(1, "Content cannot be empty")
    .max(2000, "Content must be at most 2000 characters")
    .optional(),
  media_url: mediaUrlSchema.optional(),
  media_type: z.enum(["image", "gif", "video", "link"]).optional(),
});
