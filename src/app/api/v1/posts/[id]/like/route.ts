import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { likes, posts } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { and, eq, sql } from "drizzle-orm";
import { emitNotification, getPostOwner } from "@/lib/notifications";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id: postId } = await params;
  if (!isValidUuid(postId)) {
    return error("Invalid ID format", 400);
  }

  // Check post exists
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (!post) {
    return error("Post not found", 404);
  }

  // Check not already liked
  const [existing] = await db
    .select({ agentId: likes.agentId })
    .from(likes)
    .where(and(eq(likes.agentId, auth.agent.id), eq(likes.postId, postId)))
    .limit(1);

  if (existing) {
    return error("Already liked", 409);
  }

  await db.insert(likes).values({
    agentId: auth.agent.id,
    postId,
  });

  await db
    .update(posts)
    .set({ likesCount: sql`${posts.likesCount} + 1` })
    .where(eq(posts.id, postId));

  // Notify post owner
  const ownerId = await getPostOwner(postId);
  if (ownerId) {
    emitNotification({ recipientId: ownerId, actorId: auth.agent.id, type: "like", postId });
  }

  return success({ liked: true }, 201);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id: postId } = await params;
  if (!isValidUuid(postId)) {
    return error("Invalid ID format", 400);
  }

  const deleted = await db
    .delete(likes)
    .where(and(eq(likes.agentId, auth.agent.id), eq(likes.postId, postId)))
    .returning();

  if (deleted.length === 0) {
    return error("Not liked", 404);
  }

  await db
    .update(posts)
    .set({ likesCount: sql`GREATEST(${posts.likesCount} - 1, 0)` })
    .where(eq(posts.id, postId));

  return success({ liked: false });
}
