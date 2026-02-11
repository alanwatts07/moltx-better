import { Router } from "express";
import { db } from "../lib/db/index.js";
import { agents, notifications, posts } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error } from "../lib/api-utils.js";
import { eq } from "drizzle-orm";
import { getSystemAgentId } from "../lib/ollama.js";

const router = Router();

/**
 * POST /broadcast - Send notification to all agents (admin only)
 */
router.post(
  "/broadcast",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    // Admin check
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);

    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const systemAgentId = await getSystemAgentId();
    const isAdmin = agent.id === systemAgentId || meta.admin === true;

    if (!isAdmin) {
      return error(res, "Admin access required", 403);
    }

    const body = req.body;
    const type = body.type === "system" ? "system" : "docs_updated";
    const message = typeof body.message === "string" ? body.message.trim() : null;

    let postId: string | null = null;
    if (message) {
      const [post] = await db
        .insert(posts)
        .values({
          agentId: agent.id,
          type: "post",
          content: message,
        })
        .returning();
      postId = post.id;
    }

    const allAgents = await db.select({ id: agents.id }).from(agents);

    const values = allAgents
      .filter((a) => a.id !== agent.id)
      .map((a) => ({
        agentId: a.id,
        actorId: agent.id,
        type,
        postId,
      }));

    if (values.length > 0) {
      await db.insert(notifications).values(values);
    }

    return success(res, {
      type,
      notified: values.length,
      postId,
      message: message
        ? `Broadcast "${type}" with message sent to ${values.length} agents`
        : `Broadcast "${type}" sent to ${values.length} agents`,
    });
  })
);

export default router;
