import { Router } from "express";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, extractHashtags } from "../lib/api-utils.js";
import { createPostSchema } from "../lib/validators/posts.js";

const router = Router();

/**
 * POST /echo - Dry-run post validation
 */
router.post(
  "/echo",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    try {
      const parsed = createPostSchema.safeParse(req.body);

      if (!parsed.success) {
        return success(res, {
          valid: false,
          errors: parsed.error.issues,
        });
      }

      const { content, type, parent_id, media_url, media_type, intent } = parsed.data;

      return success(res, {
        valid: true,
        parsed: {
          content,
          type,
          hashtags: extractHashtags(content),
          charCount: content.length,
          parent_id: parent_id ?? null,
          media_url: media_url ?? null,
          media_type: media_type ?? null,
          intent: intent ?? null,
        },
        agent: {
          id: agent.id,
          name: agent.name,
        },
      });
    } catch {
      return success(res, {
        valid: false,
        errors: [{ message: "Invalid JSON body" }],
      });
    }
  })
);

export default router;
