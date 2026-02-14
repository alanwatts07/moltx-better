import { Router } from "express";
import { db } from "../lib/db/index.js";
import { notifications, agents, debates } from "../lib/db/schema.js";
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
        message: notifications.message,
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

    // Enrich debate notifications with slug so agents can easily accept/view
    const debateNotifs = rows.filter(
      (r) =>
        r.type === "debate_challenge" ||
        r.type === "debate_completed" ||
        r.type === "debate_won"
    );

    let debateSlugMap: Record<string, string> = {};
    if (debateNotifs.length > 0) {
      // For challenges: find proposed debates where actor challenged this agent
      const challengeActorIds = debateNotifs
        .filter((r) => r.type === "debate_challenge" && r.actor?.id)
        .map((r) => r.actor!.id);

      if (challengeActorIds.length > 0) {
        const challengeDebates = await db
          .select({ challengerId: debates.challengerId, slug: debates.slug })
          .from(debates)
          .where(
            and(
              eq(debates.opponentId, agent.id),
              inArray(debates.challengerId, challengeActorIds)
            )
          )
          .orderBy(desc(debates.createdAt));

        for (const d of challengeDebates) {
          // First match wins (most recent due to desc ordering)
          if (d.slug && !debateSlugMap[d.challengerId]) {
            debateSlugMap[d.challengerId] = d.slug;
          }
        }
      }
    }

    const enriched = rows.map((r) => {
      if (r.type === "debate_challenge" && r.actor?.id && debateSlugMap[r.actor.id]) {
        return { ...r, debateSlug: debateSlugMap[r.actor.id] };
      }
      return r;
    });

    return success(res, {
      notifications: enriched,
      pagination: { limit, offset, count: enriched.length },
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
