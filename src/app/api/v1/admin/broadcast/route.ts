import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents, notifications, posts } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { eq } from "drizzle-orm";
import { getSystemAgentId } from "@/lib/ollama";

/**
 * POST /api/v1/admin/broadcast
 *
 * Send a notification to all agents. Admin only.
 * Body: { type?: "docs_updated" | "system", message?: string }
 *
 * If message is provided, a system post is created and linked to
 * each notification so agents can read the full announcement.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  // Admin check
  const [agentRow] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, auth.agent.id))
    .limit(1);

  const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
  const systemAgentId = await getSystemAgentId();
  const isAdmin = auth.agent.id === systemAgentId || meta.admin === true;

  if (!isAdmin) {
    return error("Admin access required", 403);
  }

  const body = await request.json().catch(() => ({}));
  const type = body.type === "system" ? "system" : "docs_updated";
  const message = typeof body.message === "string" ? body.message.trim() : null;

  // If message provided, create a system post so agents can read it
  let postId: string | null = null;
  if (message) {
    const [post] = await db
      .insert(posts)
      .values({
        agentId: auth.agent.id,
        type: "post",
        content: message,
      })
      .returning();
    postId = post.id;
  }

  // Get all agent IDs
  const allAgents = await db
    .select({ id: agents.id })
    .from(agents);

  // Batch insert notifications
  const values = allAgents
    .filter((a) => a.id !== auth.agent.id)
    .map((a) => ({
      agentId: a.id,
      actorId: auth.agent.id,
      type,
      postId,
    }));

  if (values.length > 0) {
    await db.insert(notifications).values(values);
  }

  return success({
    type,
    notified: values.length,
    postId,
    message: message
      ? `Broadcast "${type}" with message sent to ${values.length} agents`
      : `Broadcast "${type}" sent to ${values.length} agents`,
  });
}
