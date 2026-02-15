import { Router } from "express";
import { db } from "../lib/db/index.js";
import { agents, posts, debates, debateStats, tournamentParticipants, tournaments } from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success, paginationParams } from "../lib/api-utils.js";
import { eq, desc, ne, sql, gt, and, isNotNull, isNull } from "drizzle-orm";

const router = Router();

const SYSTEM_BOT_NAME = "system";

/**
 * GET / - Influence leaderboard
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const postStats = db
      .select({
        agentId: posts.agentId,
        totalPostViews: sql<number>`COALESCE(SUM(${posts.viewsCount}), 0)`.as("total_post_views"),
        totalLikes: sql<number>`COALESCE(SUM(${posts.likesCount}), 0)`.as("total_likes"),
        totalReplies: sql<number>`COALESCE(SUM(${posts.repliesCount}), 0)`.as("total_replies"),
      })
      .from(posts)
      .groupBy(posts.agentId)
      .as("post_stats");

    const influenceScore = sql<number>`
      COALESCE(${postStats.totalPostViews}, 0) * 3 +
      COALESCE(${postStats.totalLikes}, 0) * 10 +
      COALESCE(${postStats.totalReplies}, 0) * 15 +
      ${agents.followersCount} * 10 +
      SQRT(GREATEST(${agents.postsCount}, 0)) * 15 +
      COALESCE((SELECT votes_cast FROM debate_stats WHERE agent_id = ${agents.id}), 0) * 100 +
      COALESCE((SELECT wins FROM debate_stats WHERE agent_id = ${agents.id}), 0) * 30 +
      COALESCE((SELECT influence_bonus FROM debate_stats WHERE agent_id = ${agents.id}), 0)
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
        totalLikes: sql<number>`COALESCE(${postStats.totalLikes}, 0)`,
        totalReplies: sql<number>`COALESCE(${postStats.totalReplies}, 0)`,
        influenceScore: sql<number>`ROUND(${influenceScore})`,
      })
      .from(agents)
      .leftJoin(postStats, eq(agents.id, postStats.agentId))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${influenceScore} DESC`)
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
      engagement: Number(row.totalLikes) + Number(row.totalReplies),
    }));

    return success(res, {
      agents: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /debates - Debate leaderboard
 */
router.get(
  "/debates",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0)`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        debatesTotal: debateStats.debatesTotal,
        wins: debateStats.wins,
        losses: debateStats.losses,
        forfeits: debateStats.forfeits,
        votesReceived: debateStats.votesReceived,
        votesCast: debateStats.votesCast,
        debateScore: totalScore,
        seriesWins: debateStats.seriesWins,
        seriesLosses: debateStats.seriesLosses,
        seriesWinsBo3: debateStats.seriesWinsBo3,
        seriesWinsBo5: debateStats.seriesWinsBo5,
        seriesWinsBo7: debateStats.seriesWinsBo7,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${totalScore} DESC`)
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
    }));

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /debates/detailed - Detailed debate stats spreadsheet
 */
router.get(
  "/debates/detailed",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0)`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        debatesTotal: debateStats.debatesTotal,
        wins: debateStats.wins,
        losses: debateStats.losses,
        forfeits: debateStats.forfeits,
        votesReceived: debateStats.votesReceived,
        votesCast: debateStats.votesCast,
        debateScore: totalScore,
        influenceBonus: debateStats.influenceBonus,
        playoffWins: debateStats.playoffWins,
        playoffLosses: debateStats.playoffLosses,
        tocWins: debateStats.tocWins,
        tournamentsEntered: debateStats.tournamentsEntered,
        tournamentEloBonus: debateStats.tournamentEloBonus,
        seriesWins: debateStats.seriesWins,
        seriesLosses: debateStats.seriesLosses,
        seriesWinsBo3: debateStats.seriesWinsBo3,
        seriesWinsBo5: debateStats.seriesWinsBo5,
        seriesWinsBo7: debateStats.seriesWinsBo7,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${totalScore} DESC`)
      .limit(limit)
      .offset(offset);

    // Compute PRO/CON win breakdown per agent
    const agentIds = rows.map((r) => r.agentId);
    let proConMap: Record<string, { proWins: number; conWins: number }> = {};

    if (agentIds.length > 0) {
      // PRO wins: agent was challenger and won
      const proWinsRows = await db
        .select({
          agentId: debates.challengerId,
          count: sql<number>`COUNT(*)`.as("cnt"),
        })
        .from(debates)
        .where(
          and(
            isNotNull(debates.winnerId),
            sql`${debates.winnerId} = ${debates.challengerId}`,
            sql`${debates.challengerId} = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])`,
            isNull(debates.tournamentMatchId)
          )
        )
        .groupBy(debates.challengerId);

      // CON wins: agent was opponent and won
      const conWinsRows = await db
        .select({
          agentId: debates.opponentId,
          count: sql<number>`COUNT(*)`.as("cnt"),
        })
        .from(debates)
        .where(
          and(
            isNotNull(debates.winnerId),
            sql`${debates.winnerId} = ${debates.opponentId}`,
            sql`${debates.opponentId} = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])`,
            isNull(debates.tournamentMatchId)
          )
        )
        .groupBy(debates.opponentId);

      for (const r of proWinsRows) {
        if (!proConMap[r.agentId]) proConMap[r.agentId] = { proWins: 0, conWins: 0 };
        proConMap[r.agentId].proWins = Number(r.count);
      }
      for (const r of conWinsRows) {
        const id = r.agentId!;
        if (!proConMap[id]) proConMap[id] = { proWins: 0, conWins: 0 };
        proConMap[id].conWins = Number(r.count);
      }
    }

    const ranked = rows.map((row, i) => {
      const resolved = (row.wins ?? 0) + (row.losses ?? 0) + (row.forfeits ?? 0);
      const seriesResolved = (row.seriesWins ?? 0) + (row.seriesLosses ?? 0);
      const pc = proConMap[row.agentId] ?? { proWins: 0, conWins: 0 };
      const totalProCon = pc.proWins + pc.conWins;

      return {
        rank: offset + i + 1,
        ...row,
        winRate: resolved > 0 ? Math.round(((row.wins ?? 0) / resolved) * 100) : 0,
        seriesWinRate: seriesResolved > 0 ? Math.round(((row.seriesWins ?? 0) / seriesResolved) * 100) : 0,
        proWins: pc.proWins,
        conWins: pc.conWins,
        proWinPct: totalProCon > 0 ? Math.round((pc.proWins / totalProCon) * 100) : 0,
        conWinPct: totalProCon > 0 ? Math.round((pc.conWins / totalProCon) * 100) : 0,
      };
    });

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /tournaments - Tournament leaderboard
 */
router.get(
  "/tournaments",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0)`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        tocWins: debateStats.tocWins,
        playoffWins: debateStats.playoffWins,
        playoffLosses: debateStats.playoffLosses,
        tournamentsEntered: debateStats.tournamentsEntered,
        debateScore: totalScore,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(gt(debateStats.tournamentsEntered, 0))
      .orderBy(
        desc(debateStats.tocWins),
        desc(debateStats.playoffWins),
        sql`${totalScore} DESC`
      )
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
    }));

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

export default router;
