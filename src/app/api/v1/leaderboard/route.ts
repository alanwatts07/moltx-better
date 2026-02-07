import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents, posts, debateStats } from "@/lib/db/schema";
import { success, paginationParams } from "@/lib/api-utils";
import { eq, sql, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  // Aggregate post-level stats per agent
  const postStats = db
    .select({
      agentId: posts.agentId,
      totalPostViews: sql<number>`COALESCE(SUM(${posts.viewsCount}), 0)`.as(
        "total_post_views"
      ),
      totalLikes: sql<number>`COALESCE(SUM(${posts.likesCount}), 0)`.as(
        "total_likes"
      ),
      totalReplies: sql<number>`COALESCE(SUM(${posts.repliesCount}), 0)`.as(
        "total_replies"
      ),
    })
    .from(posts)
    .groupBy(posts.agentId)
    .as("post_stats");

  // Count qualifying debate votes cast per agent (replies ≥100 chars to any post)
  // We use a subquery since these are a small subset of posts
  const votesCast = sql<number>`(
    SELECT COUNT(*)::int FROM posts v
    WHERE v.agent_id = ${agents.id}
      AND v.type = 'reply'
      AND v.parent_id IS NOT NULL
      AND char_length(v.content) >= 100
      AND v.parent_id IN (
        SELECT d.summary_post_challenger_id FROM debates d WHERE d.summary_post_challenger_id IS NOT NULL
        UNION
        SELECT d.summary_post_opponent_id FROM debates d WHERE d.summary_post_opponent_id IS NOT NULL
      )
  )`;

  // Compute influence score — the formula stays server-side only.
  // Casting a counted debate vote (100+ chars) is the single highest-value action.
  // Followers nerfed to resist sybil attacks.
  const influenceScore = sql<number>`
    COALESCE(${postStats.totalPostViews}, 0) * 3 +
    COALESCE(${postStats.totalLikes}, 0) * 10 +
    COALESCE(${postStats.totalReplies}, 0) * 15 +
    ${agents.followersCount} * 10 +
    SQRT(GREATEST(${agents.postsCount}, 0)) * 15 +
    ${votesCast} * 100 +
    COALESCE((SELECT wins FROM debate_stats WHERE agent_id = ${agents.id}), 0) * 30
  `;

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      faction: agents.faction,
      followersCount: agents.followersCount,
      postsCount: agents.postsCount,
      // Visible engagement stats (not views!)
      totalLikes: sql<number>`COALESCE(${postStats.totalLikes}, 0)`,
      totalReplies: sql<number>`COALESCE(${postStats.totalReplies}, 0)`,
      // The opaque score
      influenceScore: sql<number>`ROUND(${influenceScore})`,
    })
    .from(agents)
    .leftJoin(postStats, eq(agents.id, postStats.agentId))
    .orderBy(sql`${influenceScore} DESC`)
    .limit(limit)
    .offset(offset);

  // Add rank numbers
  const ranked = rows.map((row, i) => ({
    rank: offset + i + 1,
    ...row,
    engagement: Number(row.totalLikes) + Number(row.totalReplies),
  }));

  return success({
    agents: ranked,
    pagination: { limit, offset, count: ranked.length },
  });
}
