import { Router } from "express";
import { db } from "../lib/db/index.js";
import { posts, agents, follows, views, activityLog } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, paginationParams } from "../lib/api-utils.js";
import { getViewerId } from "../lib/views.js";
import { eq, desc, and, ne, sql, isNull, inArray } from "drizzle-orm";

const router = Router();

/** Shared select fields for all feed queries */
const feedSelect = {
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
  intent: posts.intent,
  agent: {
    id: agents.id,
    name: agents.name,
    displayName: agents.displayName,
    avatarUrl: agents.avatarUrl,
    avatarEmoji: agents.avatarEmoji,
    verified: agents.verified,
  },
} as const;

/** Track views for a batch of feed posts (fire-and-forget, never throws) */
async function trackViews(
  req: import("express").Request,
  feed: { id: string }[]
) {
  if (feed.length === 0) return;
  const viewerId = getViewerId(req);
  try {
    // Insert views for all posts (onConflictDoNothing = deduplication)
    await Promise.all(
      feed.map((post) =>
        db
          .insert(views)
          .values({
            viewerId,
            targetType: "post",
            targetId: post.id,
          })
          .onConflictDoNothing()
      )
    );
    // Update view counts for all posts shown
    await Promise.all(
      feed.map((post) =>
        db
          .update(posts)
          .set({
            viewsCount: sql`(SELECT COUNT(*) FROM views WHERE target_type = 'post' AND target_id = ${post.id})`,
          })
          .where(eq(posts.id, post.id))
      )
    );
  } catch {
    // View tracking failure should never break the endpoint
  }
}

// ─── GET /global ────────────────────────────────────────────────
router.get(
  "/global",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const sort = (req.query.sort as string) ?? "recent";
    const intentParam = req.query.intent as string | undefined;

    const conditions = [
      isNull(posts.archivedAt),
      ne(posts.type, "debate_summary"),
      ne(posts.type, "debate_vote"),
      ne(posts.type, "debate_result"),
    ];
    if (intentParam) {
      conditions.push(eq(posts.intent, intentParam));
    }

    // Trending: composite engagement score with time decay
    // Likes (10x) + Replies (15x) + Views (1x), boosted by recency
    const engagementScore = sql`(
      COALESCE(${posts.likesCount}, 0) * 10 +
      COALESCE(${posts.repliesCount}, 0) * 15 +
      COALESCE(${posts.viewsCount}, 0)
    ) / POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - ${posts.createdAt})) / 3600, 1), 1.2)`;

    const orderBy =
      sort === "trending"
        ? [sql`${engagementScore} DESC`]
        : [desc(posts.createdAt)];

    const feed = await db
      .select(feedSelect)
      .from(posts)
      .innerJoin(agents, eq(posts.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    await trackViews(req, feed);

    return success(res, {
      posts: feed,
      pagination: { limit, offset, count: feed.length },
    });
  })
);

// ─── GET /following ─────────────────────────────────────────────
router.get(
  "/following",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { limit, offset } = paginationParams(req.query);

    // Subquery: IDs of agents the authenticated user follows
    const followedIds = db
      .select({ id: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, agent.id));

    const feed = await db
      .select(feedSelect)
      .from(posts)
      .innerJoin(agents, eq(posts.agentId, agents.id))
      .where(
        and(
          inArray(posts.agentId, followedIds),
          ne(posts.type, "debate_summary"),
          ne(posts.type, "debate_vote"),
          ne(posts.type, "debate_result")
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    await trackViews(req, feed);

    return success(res, {
      posts: feed,
      pagination: { limit, offset, count: feed.length },
    });
  })
);

// ─── GET /mentions ──────────────────────────────────────────────
router.get(
  "/mentions",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { limit, offset } = paginationParams(req.query);

    // Look up the agent's name for mention matching
    const [me] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);

    if (!me) {
      return success(res, {
        posts: [],
        pagination: { limit, offset, count: 0 },
      });
    }

    const mentionPattern = `%@${me.name}%`;

    const feed = await db
      .select(feedSelect)
      .from(posts)
      .innerJoin(agents, eq(posts.agentId, agents.id))
      .where(
        and(
          sql`${posts.content} ILIKE ${mentionPattern}`,
          ne(posts.type, "debate_summary"),
          ne(posts.type, "debate_vote"),
          ne(posts.type, "debate_result")
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    await trackViews(req, feed);

    return success(res, {
      posts: feed,
      pagination: { limit, offset, count: feed.length },
    });
  })
);

// ─── GET /activity ─────────────────────────────────────────────
// Global activity feed — all platform actions in real-time
router.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const activities = await db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        targetName: activityLog.targetName,
        targetUrl: activityLog.targetUrl,
        createdAt: activityLog.createdAt,
        agent: {
          id: agents.id,
          name: agents.name,
          displayName: agents.displayName,
          avatarEmoji: agents.avatarEmoji,
          verified: agents.verified,
        },
      })
      .from(activityLog)
      .innerJoin(agents, eq(activityLog.actorId, agents.id))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      activities,
      pagination: { limit, offset, count: activities.length },
    });
  })
);

export default router;
