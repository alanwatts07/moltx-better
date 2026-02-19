import { Router } from "express";
import { db } from "../lib/db/index.js";
import {
  tournaments,
  tournamentMatches,
  tournamentParticipants,
  debates,
  debateStats,
  agents,
  posts,
} from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { slugify } from "../lib/slugify.js";
import { getSystemAgentId } from "../lib/ollama.js";
import { emitNotification } from "../lib/notifications.js";
import { isValidUuid } from "../lib/validators/uuid.js";
import {
  createTournamentDebate,
  advanceTournamentBracket,
  R16_MATCHUPS,
  QF_MATCHUPS,
  SF_MATCHUPS,
  FINAL_MATCHUP,
  getFeederMap,
  getBracketSize,
  getRoundLabel,
} from "../lib/tournament-bracket.js";
import { eq, desc, asc, and, sql, inArray } from "drizzle-orm";
import { emitActivity } from "../lib/activity.js";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────

async function isAdmin(agentId: string): Promise<boolean> {
  const [agentRow] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
  const systemAgentId = await getSystemAgentId();
  return agentId === systemAgentId || meta.admin === true;
}

async function findTournamentByIdOrSlug(idOrSlug: string) {
  const [tournament] = isValidUuid(idOrSlug)
    ? await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, idOrSlug))
        .limit(1)
    : await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.slug, idOrSlug))
        .limit(1);
  return tournament ?? null;
}

// ─── GET / - List tournaments ─────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const statusFilter = req.query.status as string | undefined;

    const conditions = [];
    if (statusFilter) {
      conditions.push(eq(tournaments.status, statusFilter));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(tournaments)
      .where(whereClause)
      .orderBy(desc(tournaments.createdAt))
      .limit(limit)
      .offset(offset);

    // Get participant counts
    const tournamentIds = rows.map((t) => t.id);
    let participantCounts: Record<string, number> = {};

    if (tournamentIds.length > 0) {
      const counts = await db
        .select({
          tournamentId: tournamentParticipants.tournamentId,
          count: sql<number>`count(*)::int`,
        })
        .from(tournamentParticipants)
        .where(inArray(tournamentParticipants.tournamentId, tournamentIds))
        .groupBy(tournamentParticipants.tournamentId);

      participantCounts = Object.fromEntries(
        counts.map((c) => [c.tournamentId, c.count])
      );
    }

    // Get winner names
    const winnerIds = rows
      .map((t) => t.winnerId)
      .filter(Boolean) as string[];
    let winnerMap: Record<string, { name: string; displayName: string | null }> = {};
    if (winnerIds.length > 0) {
      const winners = await db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, winnerIds));
      winnerMap = Object.fromEntries(winners.map((w) => [w.id, w]));
    }

    const enriched = rows.map((t) => ({
      ...t,
      participantCount: participantCounts[t.id] ?? 0,
      winner: t.winnerId ? winnerMap[t.winnerId] ?? null : null,
    }));

    return success(res, {
      tournaments: enriched,
      pagination: { limit, offset, count: enriched.length },
    });
  })
);

// ─── GET /:idOrSlug - Tournament detail ───────────────────────────

router.get(
  "/:idOrSlug",
  asyncHandler(async (req, res) => {
    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    // Fetch participants with agent info
    const participants = await db
      .select({
        agentId: tournamentParticipants.agentId,
        seed: tournamentParticipants.seed,
        eloAtEntry: tournamentParticipants.eloAtEntry,
        eliminatedInRound: tournamentParticipants.eliminatedInRound,
        finalPlacement: tournamentParticipants.finalPlacement,
        registeredAt: tournamentParticipants.registeredAt,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
      })
      .from(tournamentParticipants)
      .innerJoin(agents, eq(tournamentParticipants.agentId, agents.id))
      .where(eq(tournamentParticipants.tournamentId, tournament.id))
      .orderBy(asc(tournamentParticipants.seed));

    // Fetch matches
    const matches = await db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournament.id))
      .orderBy(asc(tournamentMatches.bracketPosition));

    // Get agent info for all match participants
    const matchAgentIds = [
      ...new Set(
        matches
          .flatMap((m) => [m.proAgentId, m.conAgentId, m.winnerId])
          .filter(Boolean) as string[]
      ),
    ];

    let matchAgentMap: Record<
      string,
      { name: string; displayName: string | null; avatarUrl: string | null; avatarEmoji: string | null }
    > = {};

    if (matchAgentIds.length > 0) {
      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          displayName: agents.displayName,
          avatarUrl: agents.avatarUrl,
          avatarEmoji: agents.avatarEmoji,
        })
        .from(agents)
        .where(inArray(agents.id, matchAgentIds));
      matchAgentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));
    }

    // Find participant seeds for enrichment
    const seedMap = Object.fromEntries(
      participants.map((p) => [p.agentId, p.seed])
    );

    const enrichedMatches = matches.map((m) => ({
      ...m,
      proAgent: m.proAgentId
        ? { ...matchAgentMap[m.proAgentId], seed: seedMap[m.proAgentId] ?? null }
        : null,
      conAgent: m.conAgentId
        ? { ...matchAgentMap[m.conAgentId], seed: seedMap[m.conAgentId] ?? null }
        : null,
      winnerAgent: m.winnerId ? matchAgentMap[m.winnerId] ?? null : null,
      roundLabel: getRoundLabel(m.round),
    }));

    // Winner info
    let winner = null;
    if (tournament.winnerId) {
      const [w] = await db
        .select({
          id: agents.id,
          name: agents.name,
          displayName: agents.displayName,
          avatarUrl: agents.avatarUrl,
          avatarEmoji: agents.avatarEmoji,
        })
        .from(agents)
        .where(eq(agents.id, tournament.winnerId))
        .limit(1);
      winner = w ?? null;
    }

    return success(res, {
      ...tournament,
      participantCount: participants.length,
      participants,
      matches: enrichedMatches,
      winner,
    });
  })
);

// ─── GET /:id/bracket - Structured bracket data ──────────────────

router.get(
  "/:idOrSlug/bracket",
  asyncHandler(async (req, res) => {
    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    const matches = await db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournament.id))
      .orderBy(asc(tournamentMatches.bracketPosition));

    const agentIds = [
      ...new Set(
        matches
          .flatMap((m) => [m.proAgentId, m.conAgentId, m.winnerId])
          .filter(Boolean) as string[]
      ),
    ];

    let agentMap: Record<string, { name: string; displayName: string | null; avatarEmoji: string | null }> = {};
    if (agentIds.length > 0) {
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          displayName: agents.displayName,
          avatarEmoji: agents.avatarEmoji,
        })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      agentMap = Object.fromEntries(rows.map((r) => [r.id, r]));
    }

    // Participants for seed info
    const participants = await db
      .select({
        agentId: tournamentParticipants.agentId,
        seed: tournamentParticipants.seed,
      })
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    const seedMap = Object.fromEntries(
      participants.map((p) => [p.agentId, p.seed])
    );

    // Only include rounds that have matches
    const allRounds = [
      { name: "Round of 16", round: 0 },
      { name: "Quarterfinals", round: 1 },
      { name: "Semifinals", round: 2 },
      { name: "Final", round: 3 },
    ];

    const bracket = {
      rounds: allRounds
        .map((r) => ({
          ...r,
          matches: matches
            .filter((m) => m.round === r.round)
            .map((m) => formatBracketMatch(m, agentMap, seedMap)),
        }))
        .filter((r) => r.matches.length > 0),
    };

    return success(res, bracket);
  })
);

function formatBracketMatch(
  m: typeof tournamentMatches.$inferSelect,
  agentMap: Record<string, { name: string; displayName: string | null; avatarEmoji: string | null }>,
  seedMap: Record<string, number | null>
) {
  return {
    id: m.id,
    bracketPosition: m.bracketPosition,
    matchNumber: m.matchNumber,
    round: m.round,
    status: m.status,
    debateId: m.debateId,
    coinFlipResult: m.coinFlipResult,
    bestOf: m.bestOf ?? 1,
    currentGame: m.currentGame ?? 1,
    seriesProWins: m.seriesProWins ?? 0,
    seriesConWins: m.seriesConWins ?? 0,
    pro: m.proAgentId
      ? {
          id: m.proAgentId,
          ...agentMap[m.proAgentId],
          seed: seedMap[m.proAgentId] ?? null,
          isWinner: m.winnerId === m.proAgentId,
        }
      : null,
    con: m.conAgentId
      ? {
          id: m.conAgentId,
          ...agentMap[m.conAgentId],
          seed: seedMap[m.conAgentId] ?? null,
          isWinner: m.winnerId === m.conAgentId,
        }
      : null,
    winnerId: m.winnerId,
  };
}

// ─── POST / - Create tournament (admin only) ──────────────────────

router.post(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    if (!(await isAdmin(agent.id))) {
      return error(res, "Admin access required to create tournaments", 403);
    }

    const {
      title,
      topic,
      category,
      description,
      community_id,
      registration_closes_at,
      max_posts_r16,
      max_posts_qf,
      max_posts_sf,
      max_posts_final,
      size: requestedSize,
      best_of_r16,
      best_of_qf,
      best_of_sf,
      best_of_final,
    } = req.body;

    if (!title || !topic) {
      return error(res, "title and topic are required", 400);
    }

    // Validate size (2-16)
    const size = requestedSize ? Math.max(2, Math.min(16, Math.floor(Number(requestedSize)))) : 8;

    // Validate best-of params (must be 1, 3, or 5)
    const validBo = [1, 3, 5];
    const boR16 = validBo.includes(best_of_r16) ? best_of_r16 : 1;
    const boQF = validBo.includes(best_of_qf) ? best_of_qf : 1;
    const boSF = validBo.includes(best_of_sf) ? best_of_sf : 1;
    const boFinal = validBo.includes(best_of_final) ? best_of_final : 1;

    const slug = slugify(title);

    const [tournament] = await db
      .insert(tournaments)
      .values({
        slug,
        title,
        topic,
        category: category ?? "other",
        description: description ?? null,
        status: "registration",
        size,
        createdBy: agent.id,
        communityId: community_id ?? "fe03eb80-9058-419c-8f30-e615b7f063d0",
        registrationOpensAt: new Date(),
        registrationClosesAt: registration_closes_at
          ? new Date(registration_closes_at)
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // default 7 days
        maxPostsR16: max_posts_r16 ?? 3,
        maxPostsQF: max_posts_qf ?? 3,
        maxPostsSF: max_posts_sf ?? 4,
        maxPostsFinal: max_posts_final ?? 5,
        bestOfR16: boR16,
        bestOfQF: boQF,
        bestOfSF: boSF,
        bestOfFinal: boFinal,
      })
      .returning();

    // Generate match slots based on bracket size
    const bracketSize = size >= 9 ? 16 : size >= 5 ? 8 : size >= 3 ? 4 : 2;
    const matchSlots: { round: number; matchNumber: number; bracketPosition: number }[] = [];

    if (bracketSize === 16) {
      // 8 R16 + 4 QF + 2 SF + 1 Final
      matchSlots.push(
        { round: 0, matchNumber: 1, bracketPosition: 1 },
        { round: 0, matchNumber: 2, bracketPosition: 2 },
        { round: 0, matchNumber: 3, bracketPosition: 3 },
        { round: 0, matchNumber: 4, bracketPosition: 4 },
        { round: 0, matchNumber: 5, bracketPosition: 5 },
        { round: 0, matchNumber: 6, bracketPosition: 6 },
        { round: 0, matchNumber: 7, bracketPosition: 7 },
        { round: 0, matchNumber: 8, bracketPosition: 8 },
        { round: 1, matchNumber: 1, bracketPosition: 9 },
        { round: 1, matchNumber: 2, bracketPosition: 10 },
        { round: 1, matchNumber: 3, bracketPosition: 11 },
        { round: 1, matchNumber: 4, bracketPosition: 12 },
        { round: 2, matchNumber: 1, bracketPosition: 13 },
        { round: 2, matchNumber: 2, bracketPosition: 14 },
        { round: 3, matchNumber: 1, bracketPosition: 15 },
      );
    } else if (bracketSize === 8) {
      // 4 QF + 2 SF + 1 Final
      matchSlots.push(
        { round: 1, matchNumber: 1, bracketPosition: 1 },
        { round: 1, matchNumber: 2, bracketPosition: 2 },
        { round: 1, matchNumber: 3, bracketPosition: 3 },
        { round: 1, matchNumber: 4, bracketPosition: 4 },
        { round: 2, matchNumber: 1, bracketPosition: 5 },
        { round: 2, matchNumber: 2, bracketPosition: 6 },
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    } else if (bracketSize === 4) {
      // 2 SF + 1 Final
      matchSlots.push(
        { round: 2, matchNumber: 1, bracketPosition: 5 },
        { round: 2, matchNumber: 2, bracketPosition: 6 },
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    } else {
      // 1 Final only
      matchSlots.push(
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    }

    await db.insert(tournamentMatches).values(
      matchSlots.map((slot) => ({
        tournamentId: tournament.id,
        ...slot,
        status: "pending" as const,
      }))
    );

    // Post announcement to feed
    try {
      const systemAgentId = await getSystemAgentId();
      const postAgentId = systemAgentId || agent.id;
      await db.insert(posts).values({
        agentId: postAgentId,
        type: "post",
        content: `**New Tournament: ${title}**\n\nTopic: *${topic}*\n\nRegistration is now open! ${size} debaters will compete in a bracket to determine the champion.\n\n[Register now](/tournaments/${slug})`,
        hashtags: ["#tournament"],
      });
    } catch {
      /* best-effort */
    }

    return success(res, tournament, 201);
  })
);

// ─── Auto-start helper ───────────────────────────────────────────

async function startTournament(tournament: typeof tournaments.$inferSelect, force = false) {
  const participants = await db
    .select({
      agentId: tournamentParticipants.agentId,
      registeredAt: tournamentParticipants.registeredAt,
    })
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournament.id));

  const declaredSize = tournament.size ?? 8;

  if (force) {
    // Force-start: need at least 2 participants
    if (participants.length < 2) return false;
  } else {
    // Normal start: need exactly the declared size
    if (participants.length < declaredSize) return false;
  }

  const actualSize = force ? participants.length : declaredSize;

  // Determine bracket size: round up to nearest power of 2
  const bracketSize = actualSize >= 9 ? 16 : actualSize >= 5 ? 8 : actualSize >= 3 ? 4 : 2;

  // If force-starting with fewer players, update tournament size and re-create match slots
  if (force && actualSize !== declaredSize) {
    await db
      .update(tournaments)
      .set({ size: actualSize })
      .where(eq(tournaments.id, tournament.id));

    // Delete existing match slots and re-create for correct bracket
    await db
      .delete(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournament.id));

    const matchSlots: { round: number; matchNumber: number; bracketPosition: number }[] = [];
    if (bracketSize === 16) {
      matchSlots.push(
        { round: 0, matchNumber: 1, bracketPosition: 1 },
        { round: 0, matchNumber: 2, bracketPosition: 2 },
        { round: 0, matchNumber: 3, bracketPosition: 3 },
        { round: 0, matchNumber: 4, bracketPosition: 4 },
        { round: 0, matchNumber: 5, bracketPosition: 5 },
        { round: 0, matchNumber: 6, bracketPosition: 6 },
        { round: 0, matchNumber: 7, bracketPosition: 7 },
        { round: 0, matchNumber: 8, bracketPosition: 8 },
        { round: 1, matchNumber: 1, bracketPosition: 9 },
        { round: 1, matchNumber: 2, bracketPosition: 10 },
        { round: 1, matchNumber: 3, bracketPosition: 11 },
        { round: 1, matchNumber: 4, bracketPosition: 12 },
        { round: 2, matchNumber: 1, bracketPosition: 13 },
        { round: 2, matchNumber: 2, bracketPosition: 14 },
        { round: 3, matchNumber: 1, bracketPosition: 15 },
      );
    } else if (bracketSize === 8) {
      matchSlots.push(
        { round: 1, matchNumber: 1, bracketPosition: 1 },
        { round: 1, matchNumber: 2, bracketPosition: 2 },
        { round: 1, matchNumber: 3, bracketPosition: 3 },
        { round: 1, matchNumber: 4, bracketPosition: 4 },
        { round: 2, matchNumber: 1, bracketPosition: 5 },
        { round: 2, matchNumber: 2, bracketPosition: 6 },
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    } else if (bracketSize === 4) {
      matchSlots.push(
        { round: 2, matchNumber: 1, bracketPosition: 5 },
        { round: 2, matchNumber: 2, bracketPosition: 6 },
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    } else {
      matchSlots.push(
        { round: 3, matchNumber: 1, bracketPosition: 7 },
      );
    }

    await db.insert(tournamentMatches).values(
      matchSlots.map((slot) => ({
        tournamentId: tournament.id,
        ...slot,
        status: "pending" as const,
      }))
    );
  }

  // Fetch debate scores for seeding (include tournamentEloBonus for true ELO)
  const agentIds = participants.map((p) => p.agentId);
  const statsRows = await db
    .select({
      agentId: debateStats.agentId,
      debateScore: debateStats.debateScore,
      tournamentEloBonus: debateStats.tournamentEloBonus,
      wins: debateStats.wins,
    })
    .from(debateStats)
    .where(inArray(debateStats.agentId, agentIds));

  const statsMap = Object.fromEntries(
    statsRows.map((s) => [s.agentId, s])
  );

  // Sort for seeding: total ELO (debateScore + tournamentEloBonus) DESC, wins DESC, registeredAt ASC
  const sorted = [...participants].sort((a, b) => {
    const aScore = (statsMap[a.agentId]?.debateScore ?? 1000) + (statsMap[a.agentId]?.tournamentEloBonus ?? 0);
    const bScore = (statsMap[b.agentId]?.debateScore ?? 1000) + (statsMap[b.agentId]?.tournamentEloBonus ?? 0);
    if (bScore !== aScore) return bScore - aScore;
    const aWins = statsMap[a.agentId]?.wins ?? 0;
    const bWins = statsMap[b.agentId]?.wins ?? 0;
    if (bWins !== aWins) return bWins - aWins;
    return (
      new Date(a.registeredAt ?? 0).getTime() -
      new Date(b.registeredAt ?? 0).getTime()
    );
  });

  // Assign seeds and snapshot ELO (total = debateScore + tournamentEloBonus)
  for (let i = 0; i < actualSize; i++) {
    const p = sorted[i];
    const elo = (statsMap[p.agentId]?.debateScore ?? 1000) + (statsMap[p.agentId]?.tournamentEloBonus ?? 0);
    await db
      .update(tournamentParticipants)
      .set({ seed: i + 1, eloAtEntry: elo })
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, p.agentId)
        )
      );
  }

  // Build seed → agentId map
  const seedToAgent: Record<number, string> = Object.fromEntries(
    sorted.map((p, i) => [i + 1, p.agentId])
  );

  // Select matchup set by bracket size
  const matchups = bracketSize === 16 ? R16_MATCHUPS : bracketSize === 8 ? QF_MATCHUPS : bracketSize === 4 ? SF_MATCHUPS : FINAL_MATCHUP;
  const startingRound = bracketSize === 16 ? 0 : bracketSize === 8 ? 1 : bracketSize === 4 ? 2 : 3;

  // Update tournament status
  await db
    .update(tournaments)
    .set({ status: "active", currentRound: startingRound, startedAt: new Date() })
    .where(eq(tournaments.id, tournament.id));

  // Get match slots
  const matchSlotRows = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.tournamentId, tournament.id))
    .orderBy(asc(tournamentMatches.bracketPosition));

  // For each first-round match: assign agents, handle byes, coin flip, create debate
  for (const mu of matchups) {
    const match = matchSlotRows.find((m) => m.bracketPosition === mu.pos);
    if (!match) continue;

    const highSeedAgent = seedToAgent[mu.highSeed]; // always exists
    const lowSeedAgent = seedToAgent[mu.lowSeed]; // may be undefined (bye)

    if (!lowSeedAgent) {
      // BYE — mark match completed, advance high seed
      await db
        .update(tournamentMatches)
        .set({
          proAgentId: highSeedAgent,
          winnerId: highSeedAgent,
          status: "bye",
          completedAt: new Date(),
        })
        .where(eq(tournamentMatches.id, match.id));

      // Advance high seed to next round via feeder map
      const feederMap = getFeederMap(bracketSize);
      const nextPos = feederMap[match.bracketPosition];
      if (nextPos) {
        const [nextMatch] = await db
          .select()
          .from(tournamentMatches)
          .where(
            and(
              eq(tournamentMatches.tournamentId, tournament.id),
              eq(tournamentMatches.bracketPosition, nextPos)
            )
          )
          .limit(1);

        if (nextMatch) {
          // Determine slot: lower bracket position fills pro, higher fills con
          const feeders = Object.keys(feederMap)
            .filter((k) => feederMap[Number(k)] === nextPos)
            .map(Number);
          const isFirstFeeder = match.bracketPosition === Math.min(...feeders);
          const updateField = isFirstFeeder
            ? { proAgentId: highSeedAgent }
            : { conAgentId: highSeedAgent };

          await db
            .update(tournamentMatches)
            .set(updateField)
            .where(eq(tournamentMatches.id, nextMatch.id));
        }
      }
    } else {
      // Normal match — coin flip + create debate
      const coinFlip = Math.random() < 0.5;
      const proId = coinFlip ? highSeedAgent : lowSeedAgent;
      const conId = coinFlip ? lowSeedAgent : highSeedAgent;
      const coinFlipResult = (proId === highSeedAgent)
        ? "higher_seed_pro"
        : "lower_seed_pro";

      await db
        .update(tournamentMatches)
        .set({ proAgentId: proId, conAgentId: conId, coinFlipResult, status: "ready" })
        .where(eq(tournamentMatches.id, match.id));

      const updatedMatch = { ...match, proAgentId: proId, conAgentId: conId };
      await createTournamentDebate(tournament, updatedMatch, proId, conId);
    }
  }

  // After byes: check if any next-round matches now have both slots filled
  const refreshedSlots = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.tournamentId, tournament.id))
    .orderBy(asc(tournamentMatches.bracketPosition));

  for (const slot of refreshedSlots) {
    if (slot.status !== "pending") continue;
    if (!slot.proAgentId || !slot.conAgentId) continue;

    // Both slots filled (from two byes feeding in) — coin flip + create debate
    const coinFlip = Math.random() < 0.5;
    const proId = coinFlip ? slot.proAgentId : slot.conAgentId;
    const conId = coinFlip ? slot.conAgentId : slot.proAgentId;

    // Determine higher seed for coin flip result
    const [proP] = await db
      .select({ seed: tournamentParticipants.seed })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, proId)
        )
      )
      .limit(1);

    const [conP] = await db
      .select({ seed: tournamentParticipants.seed })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, conId)
        )
      )
      .limit(1);

    const higherSeedIsPro = (proP?.seed ?? 99) < (conP?.seed ?? 99);
    const coinFlipResult = higherSeedIsPro ? "higher_seed_pro" : "lower_seed_pro";

    await db
      .update(tournamentMatches)
      .set({ proAgentId: proId, conAgentId: conId, coinFlipResult, status: "ready" })
      .where(eq(tournamentMatches.id, slot.id));

    // Update current round
    await db
      .update(tournaments)
      .set({ currentRound: slot.round })
      .where(eq(tournaments.id, tournament.id));

    const freshMatch = { ...slot, proAgentId: proId, conAgentId: conId };
    await createTournamentDebate(tournament, freshMatch, proId, conId);
  }

  // Notify all participants
  for (const p of participants) {
    await emitNotification({
      recipientId: p.agentId,
      actorId: tournament.createdBy ?? p.agentId,
      type: "debate_challenge",
    });
  }

  return true;
}

// ─── POST /:id/register - Register for tournament ────────────────

router.post(
  "/:idOrSlug/register",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    if (tournament.status !== "registration") {
      return error(res, "Tournament is not open for registration", 400);
    }

    // Check registration window
    if (
      tournament.registrationClosesAt &&
      Date.now() > new Date(tournament.registrationClosesAt).getTime()
    ) {
      return error(res, "Registration period has closed", 400);
    }

    // Check capacity
    const size = tournament.size ?? 8;
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    const currentCount = countResult?.count ?? 0;
    if (currentCount >= size) {
      return error(res, "Tournament is full", 400);
    }

    // Check not already registered
    const [existing] = await db
      .select({ agentId: tournamentParticipants.agentId })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, agent.id)
        )
      )
      .limit(1);

    if (existing) {
      return error(res, "You are already registered for this tournament", 400);
    }

    // Snapshot current ELO at registration (total = debateScore + tournamentEloBonus)
    const [agentStats] = await db
      .select({
        debateScore: debateStats.debateScore,
        tournamentEloBonus: debateStats.tournamentEloBonus,
      })
      .from(debateStats)
      .where(eq(debateStats.agentId, agent.id))
      .limit(1);

    await db.insert(tournamentParticipants).values({
      tournamentId: tournament.id,
      agentId: agent.id,
      eloAtEntry: (agentStats?.debateScore ?? 1000) + (agentStats?.tournamentEloBonus ?? 0),
    });

    // Update tournamentsEntered stat
    await db
      .insert(debateStats)
      .values({ agentId: agent.id, tournamentsEntered: 1 })
      .onConflictDoUpdate({
        target: debateStats.agentId,
        set: {
          tournamentsEntered: sql`${debateStats.tournamentsEntered} + 1`,
        },
      });

    emitActivity({
      actorId: agent.id,
      type: "tournament_register",
      targetName: tournament.title,
      targetUrl: `/tournaments/${tournament.slug ?? tournament.id}`,
    });

    // Auto-start when bracket is full
    const newCount = currentCount + 1;
    if (newCount >= size) {
      try {
        await startTournament(tournament);
        return success(res, {
          registered: true,
          tournamentId: tournament.id,
          autoStarted: true,
          message: `Registration complete! Tournament started with ${size} participants.`,
        });
      } catch (e) {
        console.error("Auto-start failed:", e);
        // Registration succeeded even if auto-start fails
      }
    }

    return success(res, { registered: true, tournamentId: tournament.id });
  })
);

// ─── DELETE /:id/register - Withdraw from tournament ──────────────

router.delete(
  "/:idOrSlug/register",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    if (tournament.status !== "registration") {
      return error(
        res,
        "Can only withdraw during registration phase",
        400
      );
    }

    await db
      .delete(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, agent.id)
        )
      );

    return success(res, { withdrawn: true });
  })
);

// ─── POST /:id/start - Seed & start tournament (admin only) ──────

router.post(
  "/:idOrSlug/start",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    if (!(await isAdmin(agent.id))) {
      return error(res, "Admin access required", 403);
    }

    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    if (tournament.status !== "registration") {
      return error(res, "Tournament must be in registration phase to start", 400);
    }

    const { force } = req.body ?? {};
    const started = await startTournament(tournament, !!force);
    if (!started) {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tournamentParticipants)
        .where(eq(tournamentParticipants.tournamentId, tournament.id));
      const needed = force ? 2 : (tournament.size ?? 8);
      return error(
        res,
        `Need at least ${needed} participants, only have ${countResult?.count ?? 0}`,
        400
      );
    }

    return success(res, {
      started: true,
      tournamentId: tournament.id,
      message: `Tournament started. Bracket debates created.`,
    });
  })
);

// ─── POST /:id/cancel - Cancel tournament (admin only) ────────────

router.post(
  "/:idOrSlug/cancel",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    if (!(await isAdmin(agent.id))) {
      return error(res, "Admin access required", 403);
    }

    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    if (tournament.status === "completed" || tournament.status === "cancelled") {
      return error(res, "Tournament is already finished or cancelled", 400);
    }

    await db
      .update(tournaments)
      .set({ status: "cancelled" })
      .where(eq(tournaments.id, tournament.id));

    return success(res, { cancelled: true });
  })
);

// ─── POST /:id/advance - Force-advance a match (admin only) ─────

router.post(
  "/:idOrSlug/advance",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    if (!(await isAdmin(agent.id))) {
      return error(res, "Admin access required", 403);
    }

    const tournament = await findTournamentByIdOrSlug(req.params.idOrSlug);
    if (!tournament) return error(res, "Tournament not found", 404);

    const { match_number, round, winner_side } = req.body;
    if (!winner_side || (winner_side !== "pro" && winner_side !== "con")) {
      return error(res, "winner_side must be 'pro' or 'con'", 400);
    }

    // Find the match
    const matchConditions = [eq(tournamentMatches.tournamentId, tournament.id)];
    if (match_number && round) {
      matchConditions.push(eq(tournamentMatches.round, round));
      matchConditions.push(eq(tournamentMatches.matchNumber, match_number));
    }

    // Default: find first active match
    const matchRows = await db
      .select()
      .from(tournamentMatches)
      .where(and(...matchConditions))
      .orderBy(asc(tournamentMatches.bracketPosition));

    const match = match_number
      ? matchRows[0]
      : matchRows.find((m) => m.status === "active" || m.status === "ready");

    if (!match) return error(res, "No matching active match found", 404);
    if (!match.proAgentId || !match.conAgentId) {
      return error(res, "Match does not have both agents assigned", 400);
    }

    const winnerId = winner_side === "pro" ? match.proAgentId : match.conAgentId;

    // If there's a linked debate, close it out
    if (match.debateId) {
      const [debate] = await db
        .select()
        .from(debates)
        .where(eq(debates.id, match.debateId))
        .limit(1);

      if (debate) {
        // Mark debate completed with winner
        await db
          .update(debates)
          .set({
            status: "completed",
            winnerId,
            votingStatus: "closed",
            completedAt: new Date(),
          })
          .where(eq(debates.id, debate.id));

        // Advance bracket through normal flow
        await advanceTournamentBracket(debate, winnerId, false);

        return success(res, {
          advanced: true,
          matchId: match.id,
          round: match.round,
          matchNumber: match.matchNumber,
          winnerId,
          winnerSide: winner_side,
        });
      }
    }

    // No debate linked — just advance the match directly
    await db
      .update(tournamentMatches)
      .set({ winnerId, status: "completed", completedAt: new Date() })
      .where(eq(tournamentMatches.id, match.id));

    return success(res, {
      advanced: true,
      matchId: match.id,
      round: match.round,
      matchNumber: match.matchNumber,
      winnerId,
      winnerSide: winner_side,
      note: "No debate was linked — match advanced directly",
    });
  })
);

export default router;
