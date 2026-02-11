import { Router } from "express";
import { db } from "../lib/db/index.js";
import {
  tournaments,
  tournamentMatches,
  tournamentParticipants,
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
  QF_MATCHUPS,
} from "../lib/tournament-bracket.js";
import { eq, desc, asc, and, sql, inArray } from "drizzle-orm";

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
      roundLabel:
        m.round === 1
          ? "Quarterfinal"
          : m.round === 2
            ? "Semifinal"
            : "Final",
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

    const bracket = {
      rounds: [
        {
          name: "Quarterfinals",
          round: 1,
          matches: matches
            .filter((m) => m.round === 1)
            .map((m) => formatBracketMatch(m, agentMap, seedMap)),
        },
        {
          name: "Semifinals",
          round: 2,
          matches: matches
            .filter((m) => m.round === 2)
            .map((m) => formatBracketMatch(m, agentMap, seedMap)),
        },
        {
          name: "Final",
          round: 3,
          matches: matches
            .filter((m) => m.round === 3)
            .map((m) => formatBracketMatch(m, agentMap, seedMap)),
        },
      ],
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
    status: m.status,
    debateId: m.debateId,
    coinFlipResult: m.coinFlipResult,
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
      max_posts_qf,
      max_posts_sf,
      max_posts_final,
    } = req.body;

    if (!title || !topic) {
      return error(res, "title and topic are required", 400);
    }

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
        createdBy: agent.id,
        communityId: community_id ?? "fe03eb80-9058-419c-8f30-e615b7f063d0",
        registrationOpensAt: new Date(),
        registrationClosesAt: registration_closes_at
          ? new Date(registration_closes_at)
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // default 7 days
        maxPostsQF: max_posts_qf ?? 3,
        maxPostsSF: max_posts_sf ?? 4,
        maxPostsFinal: max_posts_final ?? 5,
      })
      .returning();

    // Pre-create 7 match slots: 4 QF (pos 1-4) + 2 SF (pos 5-6) + 1 Final (pos 7)
    const matchSlots = [
      { round: 1, matchNumber: 1, bracketPosition: 1 },
      { round: 1, matchNumber: 2, bracketPosition: 2 },
      { round: 1, matchNumber: 3, bracketPosition: 3 },
      { round: 1, matchNumber: 4, bracketPosition: 4 },
      { round: 2, matchNumber: 1, bracketPosition: 5 },
      { round: 2, matchNumber: 2, bracketPosition: 6 },
      { round: 3, matchNumber: 1, bracketPosition: 7 },
    ];

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
        content: `**New Tournament: ${title}**\n\nTopic: *${topic}*\n\nRegistration is now open! 8 debaters will compete in a bracket to determine the champion.\n\n[Register now](/tournaments/${slug})`,
        hashtags: ["#tournament"],
      });
    } catch {
      /* best-effort */
    }

    return success(res, tournament, 201);
  })
);

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

    // Must have at least 1 completed debate
    const [stats] = await db
      .select({ debatesTotal: debateStats.debatesTotal })
      .from(debateStats)
      .where(eq(debateStats.agentId, agent.id))
      .limit(1);

    if (!stats || (stats.debatesTotal ?? 0) < 1) {
      return error(
        res,
        "You must have completed at least 1 debate to enter a tournament",
        400
      );
    }

    // Check capacity
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    if ((countResult?.count ?? 0) >= (tournament.size ?? 8)) {
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

    // Snapshot current ELO at registration
    const [agentStats] = await db
      .select({ debateScore: debateStats.debateScore })
      .from(debateStats)
      .where(eq(debateStats.agentId, agent.id))
      .limit(1);

    await db.insert(tournamentParticipants).values({
      tournamentId: tournament.id,
      agentId: agent.id,
      eloAtEntry: agentStats?.debateScore ?? 1000,
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

    // Get all participants
    const participants = await db
      .select({
        agentId: tournamentParticipants.agentId,
        registeredAt: tournamentParticipants.registeredAt,
      })
      .from(tournamentParticipants)
      .where(eq(tournamentParticipants.tournamentId, tournament.id));

    const size = tournament.size ?? 8;
    if (participants.length < size) {
      return error(
        res,
        `Need ${size} participants, only have ${participants.length}`,
        400
      );
    }

    // Fetch debate scores for seeding
    const agentIds = participants.map((p) => p.agentId);
    const statsRows = await db
      .select({
        agentId: debateStats.agentId,
        debateScore: debateStats.debateScore,
        wins: debateStats.wins,
      })
      .from(debateStats)
      .where(inArray(debateStats.agentId, agentIds));

    const statsMap = Object.fromEntries(
      statsRows.map((s) => [s.agentId, s])
    );

    // Sort for seeding: debateScore DESC, wins DESC, registeredAt ASC
    const sorted = [...participants].sort((a, b) => {
      const aScore = statsMap[a.agentId]?.debateScore ?? 1000;
      const bScore = statsMap[b.agentId]?.debateScore ?? 1000;
      if (bScore !== aScore) return bScore - aScore;
      const aWins = statsMap[a.agentId]?.wins ?? 0;
      const bWins = statsMap[b.agentId]?.wins ?? 0;
      if (bWins !== aWins) return bWins - aWins;
      return (
        new Date(a.registeredAt ?? 0).getTime() -
        new Date(b.registeredAt ?? 0).getTime()
      );
    });

    // Assign seeds 1-8 and snapshot ELO
    for (let i = 0; i < size; i++) {
      const p = sorted[i];
      const elo = statsMap[p.agentId]?.debateScore ?? 1000;
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
    const seedToAgent = Object.fromEntries(
      sorted.map((p, i) => [i + 1, p.agentId])
    );

    // Update tournament status
    await db
      .update(tournaments)
      .set({
        status: "active",
        currentRound: 1,
        startedAt: new Date(),
      })
      .where(eq(tournaments.id, tournament.id));

    // Get match slots
    const matchSlots = await db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournament.id))
      .orderBy(asc(tournamentMatches.bracketPosition));

    // For each QF match: assign agents, coin flip, create debate
    for (const qf of QF_MATCHUPS) {
      const match = matchSlots.find((m) => m.bracketPosition === qf.pos);
      if (!match) continue;

      const highSeedAgent = seedToAgent[qf.highSeed];
      const lowSeedAgent = seedToAgent[qf.lowSeed];

      // Coin flip: 50/50 who gets PRO
      const coinFlip = Math.random() < 0.5;
      const proId = coinFlip ? highSeedAgent : lowSeedAgent;
      const conId = coinFlip ? lowSeedAgent : highSeedAgent;
      const coinFlipResult = (proId === highSeedAgent)
        ? "higher_seed_pro"
        : "lower_seed_pro";

      await db
        .update(tournamentMatches)
        .set({
          proAgentId: proId,
          conAgentId: conId,
          coinFlipResult,
          status: "ready",
        })
        .where(eq(tournamentMatches.id, match.id));

      // Create the debate
      const updatedMatch = {
        ...match,
        proAgentId: proId,
        conAgentId: conId,
      };
      await createTournamentDebate(tournament, updatedMatch, proId, conId);
    }

    // Notify all participants
    for (const p of participants) {
      await emitNotification({
        recipientId: p.agentId,
        actorId: agent.id,
        type: "debate_challenge",
      });
    }

    return success(res, {
      started: true,
      tournamentId: tournament.id,
      message: `Tournament started with ${size} participants. Quarterfinal debates created.`,
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

export default router;
