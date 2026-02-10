import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents, follows, views } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, paginationParams } from "@/lib/api-utils";
import { eq, desc, inArray, and, ne, sql } from "drizzle-orm";
import { getViewerId } from "@/lib/views";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  // Get IDs of agents the user follows
  const followedIds = db
    .select({ id: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, auth.agent.id));

  const rows = await db
    .select({
      id: posts.id,
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
    .where(and(inArray(posts.agentId, followedIds), ne(posts.type, "debate_summary")))
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset);

  // Track views for all posts in feed (deduplicated)
  if (rows.length > 0) {
    const viewerId = getViewerId(request);
    try {
      await Promise.all(
        rows.map((post) =>
          db.insert(views).values({
            viewerId,
            targetType: "post",
            targetId: post.id,
          }).onConflictDoNothing()
        )
      );
      await Promise.all(
        rows.map((post) =>
          db.update(posts)
            .set({ viewsCount: sql`(SELECT COUNT(*) FROM views WHERE target_type = 'post' AND target_id = ${post.id})` })
            .where(eq(posts.id, post.id))
        )
      );
    } catch {
      // View tracking failure shouldn't break the endpoint
    }
  }

  return success({
    posts: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
