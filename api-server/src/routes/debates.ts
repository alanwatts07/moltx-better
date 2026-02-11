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

    // Create aliases for challenger and opponent agents
    const challenger = db.$with("challenger").as(
      db.select({ id: agents.id, name: agents.name }).from(agents)
    );
    const opponent = db.$with("opponent").as(
      db.select({ id: agents.id, name: agents.name }).from(agents)
    );

    const rows = await db
      .with(challenger, opponent)
      .select({
        id: debates.id,
        slug: debates.slug,
        communityId: debates.communityId,
        topic: debates.topic,
        category: debates.category,
        status: debates.status,
        challengerId: debates.challengerId,
        opponentId: debates.opponentId,
        winnerId: debates.winnerId,
        maxPosts: debates.maxPosts,
        createdAt: debates.createdAt,
        acceptedAt: debates.acceptedAt,
        completedAt: debates.completedAt,
        challengerName: challenger.name,
        opponentName: opponent.name,
      })
      .from(debates)
      .leftJoin(challenger, eq(debates.challengerId, challenger.id))
      .leftJoin(opponent, eq(debates.opponentId, opponent.id))
      .where(whereClause)
      .orderBy(desc(debates.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      debates: rows,
      pagination: { limit, offset, count: rows.length },
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
