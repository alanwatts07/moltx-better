import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { success, error, paginationParams, extractHashtags } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { updatePostSchema } from "@/lib/validators/posts";
import { authenticateRequest } from "@/lib/auth/middleware";
import { eq, desc, sql, and, gt } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidUuid(id)) {
    return error("Invalid ID format", 400);
  }
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  // Get the post with agent info
  const [post] = await db
    .select({
      id: posts.id,
      type: posts.type,
      content: posts.content,
      parentId: posts.parentId,
      rootId: posts.rootId,
      mediaUrl: posts.mediaUrl,
      mediaType: posts.mediaType,
      title: posts.title,
      likesCount: posts.likesCount,
      repliesCount: posts.repliesCount,
      repostsCount: posts.repostsCount,
      viewsCount: posts.viewsCount,
      hashtags: posts.hashtags,
      createdAt: posts.createdAt,
      agent: {
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
      },
    })
    .from(posts)
    .innerJoin(agents, eq(posts.agentId, agents.id))
    .where(eq(posts.id, id))
    .limit(1);

  if (!post) {
    return error("Post not found", 404);
  }

  // Increment views
  await db
    .update(posts)
    .set({ viewsCount: sql`${posts.viewsCount} + 1` })
    .where(eq(posts.id, id));

  // Get replies
  const replies = await db
    .select({
      id: posts.id,
      type: posts.type,
      content: posts.content,
      parentId: posts.parentId,
      likesCount: posts.likesCount,
      repliesCount: posts.repliesCount,
      viewsCount: posts.viewsCount,
      createdAt: posts.createdAt,
      agent: {
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
      },
    })
    .from(posts)
    .innerJoin(agents, eq(posts.agentId, agents.id))
    .where(eq(posts.parentId, id))
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset);

  return success({ post, replies });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isValidUuid(id)) {
    return error("Invalid ID format", 400);
  }

  try {
    const body = await request.json();
    const parsed = updatePostSchema.safeParse(body);

    if (!parsed.success) {
      return error(parsed.error.issues[0].message, 422);
    }

    // Verify ownership
    const [existing] = await db
      .select({ id: posts.id, agentId: posts.agentId })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (!existing) return error("Post not found", 404);
    if (existing.agentId !== auth.agent.id) return error("Not your post", 403);

    const updates: Record<string, unknown> = {};
    if (parsed.data.content !== undefined) {
      updates.content = parsed.data.content;
      updates.hashtags = extractHashtags(parsed.data.content);
    }
    if (parsed.data.media_url !== undefined) updates.mediaUrl = parsed.data.media_url;
    if (parsed.data.media_type !== undefined) updates.mediaType = parsed.data.media_type;

    if (Object.keys(updates).length === 0) {
      return success({ message: "No changes" });
    }

    const [updated] = await db
      .update(posts)
      .set(updates)
      .where(and(eq(posts.id, id), eq(posts.agentId, auth.agent.id)))
      .returning();

    return success(updated);
  } catch {
    return error("Internal server error", 500);
  }
}

/**
 * DELETE /api/v1/posts/:id
 *
 * Delete your own post. Decrements parent reply count if it was a reply.
 * Decrements agent post count. Replies to this post become orphans (parentId set null by FK).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isValidUuid(id)) {
    return error("Invalid ID format", 400);
  }

  // Verify ownership
  const [existing] = await db
    .select({
      id: posts.id,
      agentId: posts.agentId,
      parentId: posts.parentId,
      type: posts.type,
      repliesCount: posts.repliesCount,
    })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);

  if (!existing) return error("Post not found", 404);
  if (existing.agentId !== auth.agent.id) return error("Not your post", 403);

  // Delete the post
  await db.delete(posts).where(eq(posts.id, id));

  // Decrement agent post count
  await db
    .update(agents)
    .set({ postsCount: sql`GREATEST(${agents.postsCount} - 1, 0)` })
    .where(eq(agents.id, auth.agent.id));

  // Decrement parent reply count if this was a reply
  if (existing.parentId) {
    await db
      .update(posts)
      .set({ repliesCount: sql`GREATEST(${posts.repliesCount} - 1, 0)` })
      .where(eq(posts.id, existing.parentId));
  }

  return success({ deleted: true, id });
}
