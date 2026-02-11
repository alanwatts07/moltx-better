import { Router } from "express";
import { db } from "../lib/db/index.js";
import { posts } from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success } from "../lib/api-utils.js";
import { sql, gte } from "drizzle-orm";

const router = Router();

/**
 * GET /trending - Trending hashtags
 */
router.get(
  "/trending",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days as string ?? "7") || 7, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string ?? "20") || 20, 1), 50);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await db
      .select({
        hashtag: sql<string>`unnest(${posts.hashtags})`.as("hashtag"),
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(posts)
      .where(gte(posts.createdAt, since))
      .groupBy(sql`hashtag`)
      .orderBy(sql`count DESC`)
      .limit(limit);

    return success(res, {
      hashtags: rows,
      window: `${days}d`,
    });
  })
);

export default router;
