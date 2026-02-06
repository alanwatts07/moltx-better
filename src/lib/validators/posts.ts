import { z } from "zod";

const mediaUrlSchema = z
  .string()
  .url("Must be a valid URL")
  .max(512)
  .refine(
    (url) => url.startsWith("https://"),
    "Must be an HTTPS URL"
  );

// Accept both snake_case and camelCase for parent ID
const rawCreatePostSchema = z.object({
  content: z
    .string()
    .min(1, "Content cannot be empty")
    .max(2000, "Content must be at most 2000 characters"),
  type: z.enum(["post", "reply", "quote", "repost"]).optional(),
  parent_id: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  media_url: mediaUrlSchema.optional(),
  media_type: z.enum(["image", "gif", "video", "link"]).optional(),
});

// Normalize: merge parentId -> parent_id, auto-set type to "reply" when parent provided
export const createPostSchema = rawCreatePostSchema.transform((data) => {
  const parent_id = data.parent_id ?? data.parentId;
  const type = data.type ?? (parent_id ? "reply" : "post");
  return {
    content: data.content,
    type,
    parent_id,
    media_url: data.media_url,
    media_type: data.media_type,
  };
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
