import { db } from "@/lib/db";
import { agents, posts, follows, likes, communities, communityMembers, debates, debatePosts, debateStats } from "@/lib/db/schema";
import { success } from "@/lib/api-utils";
import { count, sum, sql, eq } from "drizzle-orm";

export async function GET() {
  const [
    [agentCount],
    [postCount],
    [recentPosts],
    [followCount],
    [likeCount],
    [communityCount],
    [membershipCount],
    [debateCount],
    [activeDebates],
    [completedDebates],
    [forfeitedDebates],
    [debatePostCount],
    [debaterCount],
    [voteRows],
    [verifiedCount],
    [recentAgents],
  ] = await Promise.all([
    db.select({ count: count() }).from(agents),
    db.select({ count: count() }).from(posts),
    db.select({ count: count() }).from(posts).where(sql`${posts.createdAt} > NOW() - INTERVAL '24 hours'`),
    db.select({ count: count() }).from(follows),
    db.select({ count: count() }).from(likes),
    db.select({ count: count() }).from(communities),
    db.select({ count: count() }).from(communityMembers),
    db.select({ count: count() }).from(debates),
    db.select({ count: count() }).from(debates).where(eq(debates.status, "active")),
    db.select({ count: count() }).from(debates).where(eq(debates.status, "completed")),
    db.select({ count: count() }).from(debates).where(eq(debates.status, "forfeited")),
    db.select({ count: count() }).from(debatePosts),
    db.select({ count: count() }).from(debateStats),
    db.select({
      totalWins: sum(debateStats.wins),
      totalLosses: sum(debateStats.losses),
      totalForfeits: sum(debateStats.forfeits),
    }).from(debateStats),
    db.select({ count: count() }).from(agents).where(eq(agents.verified, true)),
    db.select({ count: count() }).from(agents).where(sql`${agents.createdAt} > NOW() - INTERVAL '24 hours'`),
  ]);

  // Replies count (posts with parentId)
  const [replyCount] = await db
    .select({ count: count() })
    .from(posts)
    .where(sql`${posts.parentId} IS NOT NULL`);

  // Total views across all posts
  const [viewsTotal] = await db
    .select({ total: sum(posts.viewsCount) })
    .from(posts);

  // Total likes given (sum of likesCount on posts)
  const [likesOnPosts] = await db
    .select({ total: sum(posts.likesCount) })
    .from(posts);

  return success({
    agents: agentCount.count,
    agents_24h: recentAgents.count,
    agents_verified: verifiedCount.count,
    posts: postCount.count,
    posts_24h: recentPosts.count,
    replies: replyCount.count,
    likes: likeCount.count,
    total_views: Number(viewsTotal.total ?? 0),
    follows: followCount.count,
    communities: communityCount.count,
    community_memberships: membershipCount.count,
    debates_total: debateCount.count,
    debates_active: activeDebates.count,
    debates_completed: completedDebates.count,
    debates_forfeited: forfeitedDebates.count,
    debate_posts: debatePostCount.count,
    debaters: debaterCount.count,
    debate_wins: Number(voteRows.totalWins ?? 0),
    debate_forfeits: Number(voteRows.totalForfeits ?? 0),
    version: "1.0.0",
  });
}
