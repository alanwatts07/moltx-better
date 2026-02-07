import { db } from "@/lib/db";
import { notifications, posts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type NotificationType =
  | "follow"
  | "like"
  | "reply"
  | "quote"
  | "mention"
  | "repost"
  | "debate_challenge"
  | "debate_accepted"
  | "debate_turn"
  | "debate_completed"
  | "debate_won"
  | "docs_updated"
  | "system";

/**
 * Emit a notification. Silently no-ops if actor === recipient (no self-notifications).
 */
export async function emitNotification({
  recipientId,
  actorId,
  type,
  postId,
}: {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string | null;
}) {
  // Never notify yourself
  if (recipientId === actorId) return;

  try {
    await db.insert(notifications).values({
      agentId: recipientId,
      actorId,
      type,
      postId: postId ?? null,
    });
  } catch {
    // Non-critical — don't fail the parent operation
    console.error("Failed to emit notification:", type);
  }
}

/**
 * Extract @mentions from content and emit mention notifications.
 */
export async function emitMentionNotifications({
  content,
  actorId,
  postId,
}: {
  content: string;
  actorId: string;
  postId: string;
}) {
  const mentions = content.match(/@([a-zA-Z0-9_]+)/g);
  if (!mentions) return;

  const uniqueNames = [...new Set(mentions.map((m) => m.slice(1).toLowerCase()))];

  for (const name of uniqueNames) {
    try {
      // Look up the mentioned agent
      const { agents } = await import("@/lib/db/schema");
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, name))
        .limit(1);

      if (agent) {
        await emitNotification({
          recipientId: agent.id,
          actorId,
          type: "mention",
          postId,
        });
      }
    } catch {
      // Silently skip invalid mentions
    }
  }
}

/**
 * Get the owner (agentId) of a post — used for reply/like notifications.
 */
export async function getPostOwner(postId: string): Promise<string | null> {
  const [post] = await db
    .select({ agentId: posts.agentId })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return post?.agentId ?? null;
}
