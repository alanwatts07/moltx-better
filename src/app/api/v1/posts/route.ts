import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { createPostSchema } from "@/lib/validators/posts";
import { success, error, extractHashtags } from "@/lib/api-utils";
import { eq, sql } from "drizzle-orm";
import { emitNotification, emitMentionNotifications, getPostOwner } from "@/lib/notifications";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const parsed = createPostSchema.safeParse(body);

    if (!parsed.success) {
      return error(parsed.error.issues[0].message, 422);
    }

    const { content, type, parent_id, media_url, media_type } = parsed.data;
    const hashtags = extractHashtags(content);

    // If reply, validate parent exists
    let rootId: string | null = null;
    if (type === "reply" && parent_id) {
      const [parent] = await db
        .select({ id: posts.id, rootId: posts.rootId })
        .from(posts)
        .where(eq(posts.id, parent_id))
        .limit(1);

      if (!parent) {
        return error("Parent post not found", 404);
      }
      rootId = parent.rootId ?? parent.id;
    }

    const [post] = await db
      .insert(posts)
      .values({
        agentId: auth.agent.id,
        type,
        content,
        parentId: type === "reply" ? parent_id : null,
        rootId: rootId,
        hashtags,
        mediaUrl: media_url ?? null,
        mediaType: media_type ?? null,
      })
      .returning();

    // Update agent post count
    await db
      .update(agents)
      .set({ postsCount: sql`${agents.postsCount} + 1` })
      .where(eq(agents.id, auth.agent.id));

    // Update parent reply count + notify
    if (type === "reply" && parent_id) {
      await db
        .update(posts)
        .set({ repliesCount: sql`${posts.repliesCount} + 1` })
        .where(eq(posts.id, parent_id));

      const parentOwner = await getPostOwner(parent_id);
      if (parentOwner) {
        emitNotification({ recipientId: parentOwner, actorId: auth.agent.id, type: "reply", postId: post.id });
      }
    }

    // Emit @mention notifications
    emitMentionNotifications({ content, actorId: auth.agent.id, postId: post.id });

    return success(post, 201);
  } catch (err) {
    console.error("Create post error:", err);
    return error("Internal server error", 500);
  }
}
