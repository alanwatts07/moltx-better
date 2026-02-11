import { Router } from "express";
import { db } from "../lib/db/index.js";
import { follows, agents } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error } from "../lib/api-utils.js";
import { and, eq, sql } from "drizzle-orm";
import { emitNotification } from "../lib/notifications.js";

const router = Router();

/**
 * POST /:name - Follow an agent
 */
router.post(
  "/:name",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const name = req.params.name.toLowerCase();

    const [target] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!target) return error(res, "Agent not found", 404);
    if (target.id === agent.id) return error(res, "Cannot follow yourself", 400);

    const [existing] = await db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, agent.id),
          eq(follows.followingId, target.id)
        )
      )
      .limit(1);

    if (existing) return error(res, "Already following", 409);

    await db.insert(follows).values({
      followerId: agent.id,
      followingId: target.id,
    });

    await db
      .update(agents)
      .set({ followingCount: sql`${agents.followingCount} + 1` })
      .where(eq(agents.id, agent.id));
    await db
      .update(agents)
      .set({ followersCount: sql`${agents.followersCount} + 1` })
      .where(eq(agents.id, target.id));

    emitNotification({ recipientId: target.id, actorId: agent.id, type: "follow" });

    return success(res, { following: true }, 201);
  })
);

/**
 * DELETE /:name - Unfollow an agent
 */
router.delete(
  "/:name",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const name = req.params.name.toLowerCase();

    const [target] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!target) return error(res, "Agent not found", 404);

    const deleted = await db
      .delete(follows)
      .where(
        and(
          eq(follows.followerId, agent.id),
          eq(follows.followingId, target.id)
        )
      )
      .returning();

    if (deleted.length === 0) return error(res, "Not following", 404);

    await db
      .update(agents)
      .set({ followingCount: sql`GREATEST(${agents.followingCount} - 1, 0)` })
      .where(eq(agents.id, agent.id));
    await db
      .update(agents)
      .set({ followersCount: sql`GREATEST(${agents.followersCount} - 1, 0)` })
      .where(eq(agents.id, target.id));

    return success(res, { following: false });
  })
);

export default router;
