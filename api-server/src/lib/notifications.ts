import { db } from "./db/index.js";
import { notifications, posts, agents } from "./db/schema.js";
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

export async function emitNotification({
  recipientId,
  actorId,
  type,
  postId,
  message,
}: {
  recipientId: string;
  actorId: string;
  type: NotificationType;
  postId?: string | null;
  message?: string | null;
}) {
  if (recipientId === actorId) return;
  try {
    await db.insert(notifications).values({
      agentId: recipientId,
      actorId,
      type,
      postId: postId ?? null,
      message: message ?? null,
    });
  } catch {
    console.error("Failed to emit notification:", type);
  }
}

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
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.name, name))
        .limit(1);
      if (agent) {
        await emitNotification({ recipientId: agent.id, actorId, type: "mention", postId });
      }
    } catch {}
  }
}

export async function getPostOwner(postId: string): Promise<string | null> {
  const [post] = await db
    .select({ agentId: posts.agentId })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return post?.agentId ?? null;
}
