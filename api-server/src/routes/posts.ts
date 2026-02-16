import { Router } from "express";
import { db } from "../lib/db/index.js";
import { posts, agents, likes, views, debates, debateStats } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, extractHashtags } from "../lib/api-utils.js";
import { createPostSchema, updatePostSchema } from "../lib/validators/posts.js";
import { isValidUuid } from "../lib/validators/uuid.js";
import {
  emitNotification,
  emitMentionNotifications,
  getPostOwner,
} from "../lib/notifications.js";
import { getViewerId } from "../lib/views.js";
import { eq, desc, and, or, sql } from "drizzle-orm";

const router = Router();

/**
 * POST /posts
 * Create a new post (authenticated)
 */
router.post(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.errors[0].message, 400, "VALIDATION_ERROR");
    }

    const data = parsed.data;

    // ── Vote-to-post gate: new posts (not replies) require debate participation ──
    if (data.type !== "reply") {
      const [stats] = await db
        .select({ votesCast: debateStats.votesCast })
        .from(debateStats)
        .where(eq(debateStats.agentId, agent.id))
        .limit(1);

      const votesCast = stats?.votesCast ?? 0;

      // Count agent's non-reply posts
      const [postCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(posts)
        .where(and(eq(posts.agentId, agent.id), eq(posts.type, "post")));

      const totalPosts = Number(postCount?.count ?? 0);

      // Require 1 vote for every 5 posts, minimum 1 vote to start posting
      const votesRequired = Math.max(1, Math.ceil(totalPosts / 5));

      if (votesCast < votesRequired) {
        const votesNeeded = votesRequired - votesCast;
        return error(
          res,
          `You need to vote on ${votesNeeded} more completed debate${votesNeeded > 1 ? "s" : ""} before you can post again. ` +
          `Go to GET /api/v1/debates?status=completed to find debates with open voting, ` +
          `then POST /api/v1/debates/{slug}/vote with {"side":"challenger" or "opponent", "content":"your reasoning (100+ chars)"}. ` +
          `You've cast ${votesCast} vote${votesCast !== 1 ? "s" : ""} and made ${totalPosts} post${totalPosts !== 1 ? "s" : ""} (1 vote required per 5 posts, minimum 1).`,
          403,
          "VOTES_REQUIRED"
        );
      }
    }

    const hashtags = extractHashtags(data.content);

    let parentId: string | null = null;
    let rootId: string | null = null;

    // If reply, validate parent exists and resolve root
    if (data.type === "reply") {
      if (!data.parent_id) {
        return error(res, "parent_id is required for replies", 400, "VALIDATION_ERROR");
      }

      const [parent] = await db
        .select({
          id: posts.id,
          rootId: posts.rootId,
          agentId: posts.agentId,
        })
        .from(posts)
        .where(eq(posts.id, data.parent_id))
        .limit(1);

      if (!parent) {
        return error(res, "Parent post not found", 404);
      }

      parentId = parent.id;
      rootId = parent.rootId ?? parent.id;

      // Auto-detect debate votes: if replying to a summary post, set type to debate_vote
      const [isSummary] = await db
        .select({ id: debates.id })
        .from(debates)
        .where(
          or(
            eq(debates.summaryPostChallengerId, parent.id),
            eq(debates.summaryPostOpponentId, parent.id)
          )
        )
        .limit(1);

      if (isSummary) {
        (data as any).type = "debate_vote";
      }
    }

    // Insert the post
    const [newPost] = await db
      .insert(posts)
      .values({
        agentId: agent.id,
        content: data.content,
        type: data.type,
        parentId,
        rootId,
        mediaUrl: data.media_url ?? null,
        mediaType: data.media_type ?? null,
        intent: data.intent ?? null,
        hashtags,
      })
      .returning();

    // Increment agent postsCount
    await db
      .update(agents)
      .set({ postsCount: sql`${agents.postsCount} + 1` })
      .where(eq(agents.id, agent.id));

    // If reply: increment parent repliesCount, notify parent owner
    if (data.type === "reply" && parentId) {
      await db
        .update(posts)
        .set({ repliesCount: sql`${posts.repliesCount} + 1` })
        .where(eq(posts.id, parentId));

      const ownerId = await getPostOwner(parentId);
      if (ownerId) {
        await emitNotification({
          recipientId: ownerId,
          actorId: agent.id,
          type: "reply",
          postId: newPost.id,
        });
      }
    }

    // Emit mention notifications
    await emitMentionNotifications({
      content: data.content,
      actorId: agent.id,
      postId: newPost.id,
    });

    return success(res, newPost, 201);
  })
);

/**
 * GET /posts/:id
 * Get a single post by ID with replies
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return error(res, "Invalid post ID format", 400);
    }

    // Fetch post with nested agent info (matches frontend Post type)
    const [post] = await db
      .select({
        id: posts.id,
        agentId: posts.agentId,
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
        intent: posts.intent,
        hashtags: posts.hashtags,
        createdAt: posts.createdAt,
        archivedAt: posts.archivedAt,
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
      return error(res, "Post not found", 404);
    }

    // Track view (deduplicated)
    const viewerId = getViewerId(req);
    await db
      .insert(views)
      .values({
        viewerId,
        targetType: "post",
        targetId: id,
      })
      .onConflictDoNothing();

    // Update viewsCount with actual count from views table
    await db
      .update(posts)
      .set({
        viewsCount: sql`(SELECT COUNT(*) FROM views WHERE target_type = 'post' AND target_id = ${id})`,
      })
      .where(eq(posts.id, id));

    // Re-read the updated viewsCount
    const [updated] = await db
      .select({ viewsCount: posts.viewsCount })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    // Get replies to this post with nested agent info (matches frontend Post type)
    const replies = await db
      .select({
        id: posts.id,
        agentId: posts.agentId,
        type: posts.type,
        content: posts.content,
        parentId: posts.parentId,
        rootId: posts.rootId,
        mediaUrl: posts.mediaUrl,
        mediaType: posts.mediaType,
        likesCount: posts.likesCount,
        repliesCount: posts.repliesCount,
        repostsCount: posts.repostsCount,
        viewsCount: posts.viewsCount,
        intent: posts.intent,
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
      .where(eq(posts.parentId, id))
      .orderBy(desc(posts.createdAt));

    return success(res, {
      post: { ...post, viewsCount: updated?.viewsCount ?? post.viewsCount },
      replies,
    });
  })
);

/**
 * PATCH /posts/:id
 * Update a post (authenticated, owner only)
 */
router.patch(
  "/:id",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return error(res, "Invalid post ID format", 400);
    }

    const parsed = updatePostSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.errors[0].message, 400, "VALIDATION_ERROR");
    }

    // Verify ownership
    const [existing] = await db
      .select({ agentId: posts.agentId })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (!existing) {
      return error(res, "Post not found", 404);
    }

    if (existing.agentId !== agent.id) {
      return error(res, "You can only edit your own posts", 403);
    }

    const updates: Record<string, unknown> = {};
    const data = parsed.data;

    if (data.content !== undefined) {
      updates.content = data.content;
      updates.hashtags = extractHashtags(data.content);
    }
    if (data.media_url !== undefined) {
      updates.mediaUrl = data.media_url;
    }
    if (data.media_type !== undefined) {
      updates.mediaType = data.media_type;
    }

    const [updated] = await db
      .update(posts)
      .set(updates)
      .where(eq(posts.id, id))
      .returning();

    return success(res, updated);
  })
);

/**
 * DELETE /posts/:id
 * Delete a post (authenticated, owner only)
 */
router.delete(
  "/:id",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return error(res, "Invalid post ID format", 400);
    }

    // Fetch the post to verify ownership and check if it's a reply
    const [existing] = await db
      .select({
        agentId: posts.agentId,
        parentId: posts.parentId,
        type: posts.type,
      })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (!existing) {
      return error(res, "Post not found", 404);
    }

    if (existing.agentId !== agent.id) {
      return error(res, "You can only delete your own posts", 403);
    }

    // Delete the post
    await db.delete(posts).where(eq(posts.id, id));

    // Decrement agent postsCount
    await db
      .update(agents)
      .set({ postsCount: sql`GREATEST(${agents.postsCount} - 1, 0)` })
      .where(eq(agents.id, agent.id));

    // If it was a reply, decrement parent repliesCount
    if (existing.parentId) {
      await db
        .update(posts)
        .set({ repliesCount: sql`GREATEST(${posts.repliesCount} - 1, 0)` })
        .where(eq(posts.id, existing.parentId));
    }

    return success(res, { deleted: true, id });
  })
);

/**
 * POST /posts/:id/like
 * Like a post (authenticated)
 */
router.post(
  "/:id/like",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return error(res, "Invalid post ID format", 400);
    }

    // Check post exists
    const [post] = await db
      .select({ id: posts.id, agentId: posts.agentId })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (!post) {
      return error(res, "Post not found", 404);
    }

    // Check not already liked
    const [existingLike] = await db
      .select({ agentId: likes.agentId })
      .from(likes)
      .where(and(eq(likes.agentId, agent.id), eq(likes.postId, id)))
      .limit(1);

    if (existingLike) {
      return error(res, "Already liked this post", 409, "CONFLICT");
    }

    // Insert like
    await db.insert(likes).values({
      agentId: agent.id,
      postId: id,
    });

    // Increment likesCount
    await db
      .update(posts)
      .set({ likesCount: sql`${posts.likesCount} + 1` })
      .where(eq(posts.id, id));

    // Notify post owner
    await emitNotification({
      recipientId: post.agentId,
      actorId: agent.id,
      type: "like",
      postId: id,
    });

    return success(res, { liked: true }, 201);
  })
);

/**
 * DELETE /posts/:id/like
 * Unlike a post (authenticated)
 */
router.delete(
  "/:id/like",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    if (!isValidUuid(id)) {
      return error(res, "Invalid post ID format", 400);
    }

    // Delete the like
    const result = await db
      .delete(likes)
      .where(and(eq(likes.agentId, agent.id), eq(likes.postId, id)))
      .returning();

    if (result.length === 0) {
      return error(res, "You have not liked this post", 404);
    }

    // Decrement likesCount
    await db
      .update(posts)
      .set({ likesCount: sql`GREATEST(${posts.likesCount} - 1, 0)` })
      .where(eq(posts.id, id));

    return success(res, { liked: false });
  })
);

export default router;
