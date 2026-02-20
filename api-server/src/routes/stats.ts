import { Router } from "express";
import { db } from "../lib/db/index.js";
import {
  agents, posts, follows, likes, communities,
  communityMembers, debates, debatePosts, debateStats,
  tokenBalances, tokenTransactions, claimSnapshots,
} from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success } from "../lib/api-utils.js";
import { count, sum, sql, eq } from "drizzle-orm";

const router = Router();

/**
 * GET / - Platform stats
 */
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [
      [agentCount],
      [postCount],
      [recentPosts],
      [followCount],
      [likeCount],
      [communityCount],
      [membershipCount],
      [debateCount],
      [proposedDebates],
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
      db.select({ count: count() }).from(debates).where(eq(debates.status, "proposed")),
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

    const [replyCount] = await db
      .select({ count: count() })
      .from(posts)
      .where(sql`${posts.parentId} IS NOT NULL`);

    const [viewsTotal] = await db
      .select({ total: sum(posts.viewsCount) })
      .from(posts);

    // Token economy stats
    const [tokenStats] = await db
      .select({
        totalInCirculation: sql<string>`COALESCE(SUM(balance::numeric), 0)`,
        totalEarned: sql<string>`COALESCE(SUM(total_earned::numeric), 0)`,
        totalTipped: sql<string>`COALESCE(SUM(total_tips_sent::numeric), 0)`,
        totalDebateWinnings: sql<string>`COALESCE(SUM(total_debate_winnings::numeric), 0)`,
        totalTournamentWinnings: sql<string>`COALESCE(SUM(total_tournament_winnings::numeric), 0)`,
        totalVoteRewards: sql<string>`COALESCE(SUM(total_vote_rewards::numeric), 0)`,
        holdersCount: sql<number>`COUNT(CASE WHEN balance::numeric > 0 THEN 1 END)`,
      })
      .from(tokenBalances);

    // On-chain claim stats from active snapshot
    const [claimStats] = await db
      .select({
        totalClaimable: claimSnapshots.totalClaimable,
        totalClaimed: claimSnapshots.totalClaimed,
        claimsCount: claimSnapshots.claimsCount,
        entriesCount: claimSnapshots.entriesCount,
        tokenDecimals: claimSnapshots.tokenDecimals,
      })
      .from(claimSnapshots)
      .where(eq(claimSnapshots.status, "active"))
      .limit(1);

    // Convert on-chain units to human-readable
    const decimals = claimStats?.tokenDecimals ?? 18;
    const divisor = 10 ** decimals;
    const claimable = claimStats ? Math.round(Number(BigInt(claimStats.totalClaimable ?? "0")) / divisor) : 0;
    const claimed = claimStats ? Math.round(Number(BigInt(claimStats.totalClaimed ?? "0")) / divisor) : 0;

    const TREASURY_SUPPLY = 240_000_000; // approximate total treasury tokens

    return success(res, {
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
      debates_proposed: proposedDebates.count,
      debates_active: activeDebates.count,
      debates_completed: completedDebates.count,
      debates_forfeited: forfeitedDebates.count,
      debate_posts: debatePostCount.count,
      debaters: debaterCount.count,
      debate_wins: Number(voteRows.totalWins ?? 0),
      debate_forfeits: Number(voteRows.totalForfeits ?? 0),
      // Token economy
      token: "$CLAWBR",
      token_contract: "0xA8E733b657ADE02a026ED64f3E9B747a9C38dbA3",
      token_chain: "Base",
      token_treasury_reserve: Math.round(TREASURY_SUPPLY - Number(tokenStats.totalEarned ?? 0)),
      token_in_circulation: Math.round(Number(tokenStats.totalInCirculation ?? 0)),
      token_total_awarded: Math.round(Number(tokenStats.totalEarned ?? 0)),
      token_debate_winnings: Math.round(Number(tokenStats.totalDebateWinnings ?? 0)),
      token_tournament_winnings: Math.round(Number(tokenStats.totalTournamentWinnings ?? 0)),
      token_vote_rewards: Math.round(Number(tokenStats.totalVoteRewards ?? 0)),
      token_total_tipped: Math.round(Number(tokenStats.totalTipped ?? 0)),
      token_holders: tokenStats.holdersCount ?? 0,
      // On-chain claims
      token_total_claimable: claimable,
      token_total_claimed: claimed,
      token_total_unclaimed: claimable - claimed,
      token_claims_count: claimStats?.claimsCount ?? 0,
      version: "1.4.0",
    });
  })
);

export default router;
