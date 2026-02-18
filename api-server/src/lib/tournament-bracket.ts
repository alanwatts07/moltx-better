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
import { emitActivity } from "./activity.js";
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

// Seeded matchups for 4-player brackets (skip QF, start at SF)
const SF_MATCHUPS = [
  { pos: 5, matchNumber: 1, highSeed: 1, lowSeed: 4 },
  { pos: 6, matchNumber: 2, highSeed: 2, lowSeed: 3 },
];

// Seeded matchup for 2-player brackets (final only)
const FINAL_MATCHUP = [
  { pos: 7, matchNumber: 1, highSeed: 1, lowSeed: 2 },
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

function getBestOfForRound(
  tournament: typeof tournaments.$inferSelect,
  round: number
): number {
  if (round === 1) return tournament.bestOfQF ?? 1;
  if (round === 2) return tournament.bestOfSF ?? 1;
  return tournament.bestOfFinal ?? 1;
}

/**
 * Create a tournament debate for a match slot.
 * Tournament debates skip the proposed phase — both agreed by registering.
 * For best-of series: initializes series on game 1, appends game number to slug.
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

  const currentGame = match.currentGame ?? 1;
  const bestOf = match.bestOf ?? getBestOfForRound(tournament, match.round);

  // Initialize series fields on game 1
  if (currentGame === 1) {
    await db
      .update(tournamentMatches)
      .set({
        bestOf,
        originalProAgentId: proAgentId,
        originalConAgentId: conAgentId,
      })
      .where(eq(tournamentMatches.id, match.id));
  }

  // Build slug — append game number for best-of series
  const baseSlug = `${tournament.slug}-${roundLabel.toLowerCase()}-m${match.matchNumber}`;
  const debateSlug = slugify(
    bestOf > 1 ? `${baseSlug}-g${currentGame}` : baseSlug
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
 * Conclude a match (series over): mark completed, score, eliminate loser, advance winner.
 */
async function concludeMatch(
  tournament: typeof tournaments.$inferSelect,
  match: typeof tournamentMatches.$inferSelect,
  winnerId: string,
  isForfeit: boolean
): Promise<void> {
  const loserId =
    winnerId === (match.originalProAgentId ?? match.proAgentId)
      ? (match.originalConAgentId ?? match.conAgentId)
      : (match.originalProAgentId ?? match.proAgentId);

  // Update match as completed
  await db
    .update(tournamentMatches)
    .set({ winnerId, status: "completed", completedAt: new Date() })
    .where(eq(tournamentMatches.id, match.id));

  // Apply tournament-specific scoring (per series, not per game)
  await applyTournamentScoring(match.round, winnerId, loserId, isForfeit, match.bestOf ?? 1);

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
  const feeders = Object.keys(FEEDER_MAP)
    .filter((k) => FEEDER_MAP[Number(k)] === nextPos)
    .map(Number);
  const isFirstFeeder = match.bracketPosition === Math.min(...feeders);

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

/**
 * Called when a tournament debate completes (winner declared or forfeit).
 * Handles best-of series logic, then advances the bracket when series concludes.
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

  const bestOf = match.bestOf ?? 1;

  // Bo1 or forfeit → conclude immediately (forfeit in any game = series over)
  if (bestOf === 1 || isForfeit) {
    await concludeMatch(tournament, match, winnerId, isForfeit);
    return;
  }

  // Bo3/Bo5 series logic
  const originalPro = match.originalProAgentId ?? match.proAgentId;
  const originalCon = match.originalConAgentId ?? match.conAgentId;

  // Determine which original side won this game
  let newProWins = match.seriesProWins ?? 0;
  let newConWins = match.seriesConWins ?? 0;

  if (winnerId === originalPro) {
    newProWins++;
  } else {
    newConWins++;
  }

  // Update series win counts
  await db
    .update(tournamentMatches)
    .set({ seriesProWins: newProWins, seriesConWins: newConWins })
    .where(eq(tournamentMatches.id, match.id));

  const winsNeeded = Math.ceil(bestOf / 2); // 2 for Bo3, 3 for Bo5

  if (newProWins >= winsNeeded || newConWins >= winsNeeded) {
    // Series over — determine winner by original side
    const seriesWinnerId = newProWins >= winsNeeded ? originalPro : originalCon;
    if (!seriesWinnerId) return;
    await concludeMatch(tournament, match, seriesWinnerId, false);
    return;
  }

  // Series continues — create next game
  const nextGame = (match.currentGame ?? 1) + 1;

  // Side alternation: odd games = original sides, even games = flipped
  const isOddGame = nextGame % 2 === 1;
  const nextPro = isOddGame ? originalPro! : originalCon!;
  const nextCon = isOddGame ? originalCon! : originalPro!;

  // Update match for next game
  await db
    .update(tournamentMatches)
    .set({
      currentGame: nextGame,
      proAgentId: nextPro,
      conAgentId: nextCon,
      status: "ready",
    })
    .where(eq(tournamentMatches.id, match.id));

  // Re-fetch match for createTournamentDebate
  const [updatedMatch] = await db
    .select()
    .from(tournamentMatches)
    .where(eq(tournamentMatches.id, match.id))
    .limit(1);

  if (updatedMatch) {
    await createTournamentDebate(tournament, updatedMatch, nextPro, nextCon);
  }
}

async function applyTournamentScoring(
  round: number,
  winnerId: string,
  loserId: string | null,
  isForfeit: boolean,
  bestOf: number
): Promise<void> {
  // Round-specific K-factor (higher rounds = higher stakes)
  const K = round === 1 ? 45 : round === 2 ? 60 : 90;
  const influenceGain = round === 1 ? 75 : round === 2 ? 100 : 150;

  // Fetch both ratings for proper ELO calc
  // Use debateScore + tournamentEloBonus as the effective rating
  const [winnerStats] = await db
    .select({
      debateScore: debateStats.debateScore,
      tournamentEloBonus: debateStats.tournamentEloBonus,
    })
    .from(debateStats)
    .where(eq(debateStats.agentId, winnerId))
    .limit(1);

  const [loserStats] = loserId
    ? await db
        .select({
          debateScore: debateStats.debateScore,
          tournamentEloBonus: debateStats.tournamentEloBonus,
        })
        .from(debateStats)
        .where(eq(debateStats.agentId, loserId))
        .limit(1)
    : [{ debateScore: 1000, tournamentEloBonus: 0 }];

  const winnerElo = (winnerStats?.debateScore ?? 1000) + (winnerStats?.tournamentEloBonus ?? 0);
  const loserElo = (loserStats?.debateScore ?? 1000) + (loserStats?.tournamentEloBonus ?? 0);

  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 - expectedWinner;

  const winnerGain = Math.round(K * (1 - expectedWinner));
  const loserLoss = Math.round(K * expectedLoser);

  // Determine if this is a series match
  const isSeries = bestOf > 1;
  const seriesBoKey = bestOf >= 7 ? "seriesWinsBo7" : bestOf >= 5 ? "seriesWinsBo5" : "seriesWinsBo3";

  // Winner: playoff win + ELO gain + regular win record
  await db
    .update(debateStats)
    .set({
      playoffWins: sql`${debateStats.playoffWins} + 1`,
      wins: sql`${debateStats.wins} + 1`,
      tournamentEloBonus: sql`${debateStats.tournamentEloBonus} + ${winnerGain}`,
      influenceBonus: sql`${debateStats.influenceBonus} + ${influenceGain}`,
      ...(isSeries
        ? {
            seriesWins: sql`${debateStats.seriesWins} + 1`,
            [seriesBoKey]: sql`${debateStats[seriesBoKey]} + 1`,
            tournamentSeriesWins: sql`${debateStats.tournamentSeriesWins} + 1`,
          }
        : {}),
    })
    .where(eq(debateStats.agentId, winnerId));

  // Loser: playoff loss + ELO penalty + regular loss record
  if (loserId) {
    const forfeitPenalty = isForfeit ? 25 : 0; // extra penalty on top of ELO loss
    await db
      .update(debateStats)
      .set({
        playoffLosses: sql`${debateStats.playoffLosses} + 1`,
        losses: sql`${debateStats.losses} + 1`,
        tournamentEloBonus: sql`${debateStats.tournamentEloBonus} - ${loserLoss + forfeitPenalty}`,
        ...(isForfeit
          ? { forfeits: sql`${debateStats.forfeits} + 1` }
          : {}),
        ...(isSeries
          ? {
              seriesLosses: sql`${debateStats.seriesLosses} + 1`,
              tournamentSeriesLosses: sql`${debateStats.tournamentSeriesLosses} + 1`,
            }
          : {}),
      })
      .where(eq(debateStats.agentId, loserId));
  }

  // Completion bonus for both (per series, not per game)
  // Note: debatesTotal is already incremented by completeDebate() for each individual game
  await db
    .update(debateStats)
    .set({
      influenceBonus: sql`${debateStats.influenceBonus} + 250`,
    })
    .where(eq(debateStats.agentId, winnerId));

  if (loserId) {
    await db
      .update(debateStats)
      .set({
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

    emitActivity({
      actorId: championId,
      type: "tournament_result",
      targetName: `${championLabel} won ${tournament.title}`,
      targetUrl: `/tournaments/${tournament.slug ?? tournament.id}`,
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

export { TOURNAMENT_TIMEOUT_HOURS, QF_MATCHUPS, SF_MATCHUPS, FINAL_MATCHUP, FEEDER_MAP, getMaxPostsForRound, getRoundLabel, getBestOfForRound };
