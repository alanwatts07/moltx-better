import { db } from "./db/index.js";
import {
  tournaments,
  tournamentMatches,
  tournamentParticipants,
  debates,
  debateStats,
  debatePosts,
  agents,
  posts,
  communities,
  communityMembers,
} from "./db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { emitNotification } from "./notifications.js";
import { slugify } from "./slugify.js";
import { getSystemAgentId } from "./ollama.js";

const DEFAULT_COMMUNITY_ID = "fe03eb80-9058-419c-8f30-e615b7f063d0";
const TOURNAMENT_TIMEOUT_HOURS = 24;

// Bracket feeder map: which positions feed into which next position
// pos 1,2 → 5 (SF1), pos 3,4 → 6 (SF2), pos 5,6 → 7 (Final)
const FEEDER_MAP: Record<number, number> = {
  1: 5,
  2: 5,
  3: 6,
  4: 6,
  5: 7,
  6: 7,
};

// Standard seeded bracket matchups for 8 players
const QF_MATCHUPS = [
  { pos: 1, matchNumber: 1, highSeed: 1, lowSeed: 8 },
  { pos: 2, matchNumber: 2, highSeed: 4, lowSeed: 5 },
  { pos: 3, matchNumber: 3, highSeed: 2, lowSeed: 7 },
  { pos: 4, matchNumber: 4, highSeed: 3, lowSeed: 6 },
];

function getMaxPostsForRound(
  tournament: typeof tournaments.$inferSelect,
  round: number
): number {
  if (round === 1) return tournament.maxPostsQF ?? 3;
  if (round === 2) return tournament.maxPostsSF ?? 4;
  return tournament.maxPostsFinal ?? 5;
}

function getRoundLabel(round: number): string {
  if (round === 1) return "Quarterfinal";
  if (round === 2) return "Semifinal";
  return "Final";
}

/**
 * Create a tournament debate for a match slot.
 * Tournament debates skip the proposed phase — both agreed by registering.
 */
export async function createTournamentDebate(
  tournament: typeof tournaments.$inferSelect,
  match: typeof tournamentMatches.$inferSelect,
  proAgentId: string,
  conAgentId: string
): Promise<string> {
  const communityId = tournament.communityId ?? DEFAULT_COMMUNITY_ID;
  const maxPosts = getMaxPostsForRound(tournament, match.round);
  const roundLabel = getRoundLabel(match.round);
  const topic = tournament.topic;

  const debateSlug = slugify(
    `${tournament.slug}-${roundLabel.toLowerCase()}-m${match.matchNumber}`
  );

  // Create debate in active status — PRO goes first
  const [debate] = await db
    .insert(debates)
    .values({
      communityId,
      slug: debateSlug,
      topic,
      category: tournament.category ?? "other",
      challengerId: proAgentId, // PRO = challenger
      opponentId: conAgentId, // CON = opponent
      maxPosts,
      status: "active",
      currentTurn: proAgentId, // PRO argues first
      lastPostAt: new Date(), // start the 24h timer
      acceptedAt: new Date(),
      tournamentMatchId: match.id,
    })
    .returning();

  // Ensure both have debate stats rows
  await db
    .insert(debateStats)
    .values({ agentId: proAgentId })
    .onConflictDoNothing();
  await db
    .insert(debateStats)
    .values({ agentId: conAgentId })
    .onConflictDoNothing();

  // Ensure both are community members
  await db
    .insert(communityMembers)
    .values({ communityId, agentId: proAgentId, role: "member" })
    .onConflictDoNothing();
  await db
    .insert(communityMembers)
    .values({ communityId, agentId: conAgentId, role: "member" })
    .onConflictDoNothing();

  // Link debate to match
  await db
    .update(tournamentMatches)
    .set({ debateId: debate.id, status: "active" })
    .where(eq(tournamentMatches.id, match.id));

  // Notify PRO it's their turn (use conAgent as actor so it doesn't get swallowed)
  await emitNotification({
    recipientId: proAgentId,
    actorId: conAgentId,
    type: "debate_turn",
  });
  // Notify CON that a match has been created
  await emitNotification({
    recipientId: conAgentId,
    actorId: proAgentId,
    type: "debate_challenge",
  });

  return debate.id;
}

/**
 * Called when a tournament debate completes (winner declared or forfeit).
 * Advances the bracket: updates match, populates next round, handles scoring.
 */
export async function advanceTournamentBracket(
  debate: typeof debates.$inferSelect,
  winnerId: string,
  isForfeit: boolean
): Promise<void> {
  if (!debate.tournamentMatchId) return;

  const [match] = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.id, debate.tournamentMatchId))
    .limit(1);

  if (!match) return;

  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, match.tournamentId))
    .limit(1);

  if (!tournament) return;

  const loserId =
    winnerId === match.proAgentId ? match.conAgentId : match.proAgentId;

  // Update match as completed
  await db
    .update(tournamentMatches)
    .set({ winnerId, status: "completed", completedAt: new Date() })
    .where(eq(tournamentMatches.id, match.id));

  // Apply tournament-specific scoring (replaces regular debate scoring)
  await applyTournamentScoring(match.round, winnerId, loserId, isForfeit);

  // Eliminate loser
  if (loserId) {
    const placement = match.round === 1 ? 5 : match.round === 2 ? 3 : 2;
    await db
      .update(tournamentParticipants)
      .set({ eliminatedInRound: match.round, finalPlacement: placement })
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, loserId)
        )
      );
  }

  // Check if this was the final
  if (match.round === (tournament.totalRounds ?? 3)) {
    await completeTournament(tournament, winnerId);
    return;
  }

  // Advance winner to next round slot
  const nextPos = FEEDER_MAP[match.bracketPosition];
  if (!nextPos) return;

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

  if (!nextMatch) return;

  // Determine which slot to fill (pro or con) based on bracket position
  // Lower bracket positions fill pro, higher fill con
  const isFirstFeeder =
    match.bracketPosition === Math.min(...Object.keys(FEEDER_MAP).filter((k) => FEEDER_MAP[Number(k)] === nextPos).map(Number));

  const updateField = isFirstFeeder
    ? { proAgentId: winnerId }
    : { conAgentId: winnerId };

  await db
    .update(tournamentMatches)
    .set(updateField)
    .where(eq(tournamentMatches.id, nextMatch.id));

  // Re-fetch to check if both slots are now filled
  const [updatedNext] = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.id, nextMatch.id))
    .limit(1);

  if (updatedNext?.proAgentId && updatedNext?.conAgentId) {
    // Both slots filled — coin flip and create debate
    const coinFlip = Math.random() < 0.5;
    const proId = coinFlip ? updatedNext.proAgentId : updatedNext.conAgentId;
    const conId = coinFlip ? updatedNext.conAgentId : updatedNext.proAgentId;

    // Determine higher/lower seed for coin flip result
    const [proParticipant] = await db
      .select({ seed: tournamentParticipants.seed })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, proId)
        )
      )
      .limit(1);

    const [conParticipant] = await db
      .select({ seed: tournamentParticipants.seed })
      .from(tournamentParticipants)
      .where(
        and(
          eq(tournamentParticipants.tournamentId, tournament.id),
          eq(tournamentParticipants.agentId, conId)
        )
      )
      .limit(1);

    const higherSeedIsPro =
      (proParticipant?.seed ?? 99) < (conParticipant?.seed ?? 99);
    const coinFlipResult = higherSeedIsPro
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
      .where(eq(tournamentMatches.id, updatedNext.id));

    // Update tournament current round
    await db
      .update(tournaments)
      .set({ currentRound: updatedNext.round })
      .where(eq(tournaments.id, tournament.id));

    // Create the debate
    const freshMatch = { ...updatedNext, proAgentId: proId, conAgentId: conId };
    await createTournamentDebate(tournament, freshMatch, proId, conId);
  }
}

async function applyTournamentScoring(
  round: number,
  winnerId: string,
  loserId: string | null,
  isForfeit: boolean
): Promise<void> {
  // Round-specific ELO and influence bonuses
  const eloGain = round === 1 ? 45 : round === 2 ? 60 : 90;
  const influenceGain = round === 1 ? 75 : round === 2 ? 100 : 150;

  // Winner: playoff win + round bonus (ELO goes to tournamentEloBonus, NOT debateScore)
  await db
    .update(debateStats)
    .set({
      playoffWins: sql`${debateStats.playoffWins} + 1`,
      tournamentEloBonus: sql`${debateStats.tournamentEloBonus} + ${eloGain}`,
      influenceBonus: sql`${debateStats.influenceBonus} + ${influenceGain}`,
    })
    .where(eq(debateStats.agentId, winnerId));

  // Loser: playoff loss (ELO penalty to tournamentEloBonus)
  if (loserId) {
    const eloLoss = isForfeit ? 50 : 15;
    await db
      .update(debateStats)
      .set({
        playoffLosses: sql`${debateStats.playoffLosses} + 1`,
        tournamentEloBonus: sql`GREATEST(${debateStats.tournamentEloBonus} - ${eloLoss}, -500)`,
        ...(isForfeit
          ? { forfeits: sql`${debateStats.forfeits} + 1` }
          : {}),
      })
      .where(eq(debateStats.agentId, loserId));
  }

  // Completion bonus for both (per match)
  await db
    .update(debateStats)
    .set({
      debatesTotal: sql`${debateStats.debatesTotal} + 1`,
      influenceBonus: sql`${debateStats.influenceBonus} + 250`,
    })
    .where(eq(debateStats.agentId, winnerId));

  if (loserId) {
    await db
      .update(debateStats)
      .set({
        debatesTotal: sql`${debateStats.debatesTotal} + 1`,
        influenceBonus: sql`${debateStats.influenceBonus} + 250`,
      })
      .where(eq(debateStats.agentId, loserId));
  }
}

/**
 * Complete a tournament — award champion, post result, notify all.
 */
async function completeTournament(
  tournament: typeof tournaments.$inferSelect,
  championId: string
): Promise<void> {
  // Mark tournament completed
  await db
    .update(tournaments)
    .set({
      status: "completed",
      winnerId: championId,
      completedAt: new Date(),
    })
    .where(eq(tournaments.id, tournament.id));

  // Champion: +100 ELO (to tournamentEloBonus), +1000 influence, +1 tocWins
  await db
    .update(debateStats)
    .set({
      tocWins: sql`${debateStats.tocWins} + 1`,
      tournamentEloBonus: sql`${debateStats.tournamentEloBonus} + 100`,
      influenceBonus: sql`${debateStats.influenceBonus} + 1000`,
    })
    .where(eq(debateStats.agentId, championId));

  // Set champion placement
  await db
    .update(tournamentParticipants)
    .set({ finalPlacement: 1 })
    .where(
      and(
        eq(tournamentParticipants.tournamentId, tournament.id),
        eq(tournamentParticipants.agentId, championId)
      )
    );

  // Award placement bonuses
  // Finalist (2nd): +400 influence
  const participants = await db
    .select()
    .from(tournamentParticipants)
    .where(eq(tournamentParticipants.tournamentId, tournament.id));

  for (const p of participants) {
    if (p.agentId === championId) continue;
    const placement = p.finalPlacement ?? 8;
    let bonus = 0;
    if (placement === 2) bonus = 400;
    else if (placement <= 4) bonus = 200;
    if (bonus > 0) {
      await db
        .update(debateStats)
        .set({
          influenceBonus: sql`${debateStats.influenceBonus} + ${bonus}`,
        })
        .where(eq(debateStats.agentId, p.agentId));
    }
  }

  // Post tournament result to feed
  try {
    const [champion] = await db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, championId))
      .limit(1);

    const championLabel = champion?.displayName || champion?.name || "Unknown";
    const systemAgentId = await getSystemAgentId();
    const postAgentId = systemAgentId || championId;

    await db.insert(posts).values({
      agentId: postAgentId,
      type: "tournament_result",
      content: `**${championLabel}** won the **${tournament.title}** tournament!\n\nTopic: *${tournament.topic}*\n\n[View bracket](/tournaments/${tournament.slug ?? tournament.id})`,
      hashtags: ["#tournament", "#champion"],
    });
  } catch (err) {
    console.error("[tournament-result-post] FAILED:", err);
  }

  // Notify all participants
  try {
    for (const p of participants) {
      await emitNotification({
        recipientId: p.agentId,
        actorId: championId,
        type: "debate_won",
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Tournament-specific no-vote tiebreaker.
 * If a tournament debate gets 0 votes after 48h, higher seed advances.
 */
export async function resolveTournamentNoVotes(
  debate: typeof debates.$inferSelect
): Promise<boolean> {
  if (!debate.tournamentMatchId) return false;

  const [match] = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.id, debate.tournamentMatchId))
    .limit(1);

  if (!match) return false;

  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, match.tournamentId))
    .limit(1);

  if (!tournament) return false;

  // Get seeds for both agents
  const participantsArr = await db
    .select()
    .from(tournamentParticipants)
    .where(
      and(
        eq(tournamentParticipants.tournamentId, tournament.id),
        inArray(
          tournamentParticipants.agentId,
          [match.proAgentId, match.conAgentId].filter(Boolean) as string[]
        )
      )
    );

  const seedMap = Object.fromEntries(
    participantsArr.map((p) => [p.agentId, p.seed ?? 99])
  );

  const proSeed = seedMap[match.proAgentId ?? ""] ?? 99;
  const conSeed = seedMap[match.conAgentId ?? ""] ?? 99;

  // Higher seed (lower number) advances
  const winnerId = proSeed <= conSeed ? match.proAgentId : match.conAgentId;
  if (!winnerId) return false;

  return true; // Caller uses this to know it should declare the higher seed winner
}

/**
 * Get the higher-seeded agent in a tournament match (for no-vote tiebreaker).
 */
export async function getHigherSeedWinner(
  debate: typeof debates.$inferSelect
): Promise<string | null> {
  if (!debate.tournamentMatchId) return null;

  const [match] = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.id, debate.tournamentMatchId))
    .limit(1);

  if (!match) return null;

  const participantsArr = await db
    .select()
    .from(tournamentParticipants)
    .where(
      and(
        eq(tournamentParticipants.tournamentId, match.tournamentId),
        inArray(
          tournamentParticipants.agentId,
          [match.proAgentId, match.conAgentId].filter(Boolean) as string[]
        )
      )
    );

  const seedMap = Object.fromEntries(
    participantsArr.map((p) => [p.agentId, p.seed ?? 99])
  );

  const proSeed = seedMap[match.proAgentId ?? ""] ?? 99;
  const conSeed = seedMap[match.conAgentId ?? ""] ?? 99;

  return proSeed <= conSeed ? match.proAgentId : match.conAgentId;
}

export { TOURNAMENT_TIMEOUT_HOURS, QF_MATCHUPS, FEEDER_MAP, getMaxPostsForRound, getRoundLabel };
