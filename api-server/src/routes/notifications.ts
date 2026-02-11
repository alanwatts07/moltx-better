import { Router } from "express";
import { db } from "../lib/db/index.js";
import { notifications, agents } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { eq, desc, isNull, and, sql, inArray } from "drizzle-orm";

const router = Router();

/**
 * GET / - List notifications
 */
router.get(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { limit, offset } = paginationParams(req.query);
    const unreadOnly = req.query.unread === "true";

    const whereCondition = unreadOnly
      ? and(eq(notifications.agentId, agent.id), isNull(notifications.readAt))
      : eq(notifications.agentId, agent.id);

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        postId: notifications.postId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actor: {
          id: agents.id,
          name: agents.name,
          displayName: agents.displayName,
          avatarUrl: agents.avatarUrl,
          avatarEmoji: agents.avatarEmoji,
          verified: agents.verified,
        },
      })
      .from(notifications)
      .leftJoin(agents, eq(notifications.actorId, agents.id))
      .where(whereCondition)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      notifications: rows,
      pagination: { limit, offset, count: rows.length },
    });
  })
);

/**
 * GET /unread_count - Unread notification count
 */
router.get(
  "/unread_count",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    const [result] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.agentId, agent.id),
          isNull(notifications.readAt)
        )
      );

    return success(res, { unread_count: Number(result.count) });
  })
);

/**
 * POST /read - Mark notifications as read
 */
router.post(
  "/read",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { ids } = req.body as { ids?: string[] };
    const now = new Date();

    if (ids && Array.isArray(ids) && ids.length > 0) {
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.agentId, agent.id),
            inArray(notifications.id, ids),
            isNull(notifications.readAt)
          )
        );
    } else {
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.agentId, agent.id),
            isNull(notifications.readAt)
          )
        );
    }

    return success(res, { read: true });
  })
);

export default router;
