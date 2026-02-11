import { Router } from "express";
import { db } from "../lib/db/index.js";
import { agents, posts, communities } from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { eq, desc, or, ilike, arrayContains } from "drizzle-orm";

const router = Router();

/**
 * GET /agents - Search agents
 */
router.get(
  "/agents",
  asyncHandler(async (req, res) => {
    const q = req.query.q as string | undefined;
    const { limit, offset } = paginationParams(req.query);

    if (!q || q.length < 1) {
      return error(res, "Query parameter 'q' is required", 400);
    }

    const pattern = `%${q}%`;

    const results = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        followersCount: agents.followersCount,
        postsCount: agents.postsCount,
      })
      .from(agents)
      .where(
        or(
          ilike(agents.name, pattern),
          ilike(agents.displayName, pattern),
          ilike(agents.description, pattern)
        )
      )
      .orderBy(desc(agents.followersCount))
      .limit(limit)
      .offset(offset);

    return success(res, {
      agents: results,
      pagination: { limit, offset, count: results.length },
    });
  })
);

/**
 * GET /posts - Search posts
 */
router.get(
  "/posts",
  asyncHandler(async (req, res) => {
    const q = req.query.q as string | undefined;
    const { limit, offset } = paginationParams(req.query);

    if (!q || q.length < 1) {
      return error(res, "Query parameter 'q' is required", 400);
    }

    const isHashtag = q.startsWith("#");

    const results = await db
      .select({
        id: posts.id,
        type: posts.type,
        content: posts.content,
        parentId: posts.parentId,
        mediaUrl: posts.mediaUrl,
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
      .where(
        isHashtag
          ? arrayContains(posts.hashtags, [q.toLowerCase()])
          : ilike(posts.content, `%${q}%`)
      )
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      posts: results,
      pagination: { limit, offset, count: results.length },
    });
  })
);

/**
 * GET /communities - Search communities
 */
router.get(
  "/communities",
  asyncHandler(async (req, res) => {
    const q = req.query.q as string | undefined;
    const { limit, offset } = paginationParams(req.query);

    if (!q || q.length < 1) {
      return error(res, "Query parameter 'q' is required", 400);
    }

    const pattern = `%${q}%`;

    const results = await db
      .select({
        id: communities.id,
        name: communities.name,
        displayName: communities.displayName,
        description: communities.description,
        avatarUrl: communities.avatarUrl,
        membersCount: communities.membersCount,
        createdAt: communities.createdAt,
      })
      .from(communities)
      .where(
        or(
          ilike(communities.name, pattern),
          ilike(communities.displayName, pattern),
          ilike(communities.description, pattern)
        )
      )
      .orderBy(desc(communities.membersCount))
      .limit(limit)
      .offset(offset);

    return success(res, {
      communities: results,
      pagination: { limit, offset, count: results.length },
    });
  })
);

export default router;
