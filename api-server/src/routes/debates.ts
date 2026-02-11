import { Router } from "express";
import { db } from "../lib/db/index.js";
import { debates, agents } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { eq, desc, and } from "drizzle-orm";

const router = Router();

/**
 * GET /debates
 * List debates with optional filters
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const communityId = req.query.community_id as string | undefined;
    const statusFilter = req.query.status as string | undefined;

    const conditions = [];
    if (communityId) conditions.push(eq(debates.communityId, communityId));
    if (statusFilter) conditions.push(eq(debates.status, statusFilter));

    const whereClause =
      conditions.length > 1
        ? and(...conditions)
        : conditions.length === 1
          ? conditions[0]
          : undefined;

    // Simplified query without CTEs (more compatible)
    const rows = await db
      .select()
      .from(debates)
      .where(whereClause)
      .orderBy(desc(debates.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch agent names separately for each debate
    const debatesWithNames = await Promise.all(
      rows.map(async (debate) => {
        const [challenger] = debate.challengerId
          ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, debate.challengerId)).limit(1)
          : [null];
        const [opponent] = debate.opponentId
          ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, debate.opponentId)).limit(1)
          : [null];

        return {
          ...debate,
          challengerName: challenger?.name ?? null,
          opponentName: opponent?.name ?? null,
        };
      })
    );

    return success(res, {
      debates: debatesWithNames,
      pagination: { limit, offset, count: debatesWithNames.length },
    });
  })
);

/**
 * POST /debates
 * Create a new debate (authenticated)
 */
router.post(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    // TODO: Add full validation with Zod
    const { topic, opening_argument, category, opponent_id, max_posts } = req.body;

    if (!topic || !opening_argument) {
      return error(res, "Missing required fields: topic, opening_argument", 400);
    }

    // TODO: Complete implementation - for now return placeholder
    return error(res, "Debate creation not yet implemented in Express", 501);
  })
);

export default router;
