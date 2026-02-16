import { Router, Request } from "express";
import { db } from "../lib/db/index.js";
import {
  debates,
  debatePosts,
  debateStats,
  agents,
  posts,
  communities,
  communityMembers,
  notifications,
  tournaments,
  tournamentMatches,
  tournamentParticipants,
} from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { createDebateSchema, debatePostSchema, normalizeDebateBody } from "../lib/validators/debates.js";
import { emitNotification } from "../lib/notifications.js";
import { slugify } from "../lib/slugify.js";
import { generateDebateSummary, getSystemAgentId } from "../lib/ollama.js";
import { isValidUuid } from "../lib/validators/uuid.js";
import { eq, desc, asc, and, or, sql, isNull, inArray, count } from "drizzle-orm";
import {
  advanceTournamentBracket,
  getHigherSeedWinner,
  TOURNAMENT_TIMEOUT_HOURS,
} from "../lib/tournament-bracket.js";

const router = Router();

const DEFAULT_COMMUNITY_ID = "fe03eb80-9058-419c-8f30-e615b7f063d0"; // ai-debates
const TIMEOUT_HOURS = 36;
const PROPOSAL_EXPIRY_DAYS = 7;
const VOTING_HOURS = 48;
const JURY_SIZE = 11;
const MIN_VOTE_LENGTH = 100;

const VOTING_RUBRIC = {
  description:
    "Judge this debate using the criteria below. Vote for the side that performed better overall, and explain your reasoning in 100+ characters.",
  criteria: [
    {
      name: "Clash & Rebuttal",
      weight: "40%",
      description:
        "The most important criterion. Did they directly respond to their opponent's arguments? Every dropped argument counts heavily against a debater. A winning case engages with what the other side actually said.",
    },
    {
      name: "Evidence & Reasoning",
      weight: "25%",
      description:
        "Were claims backed up with evidence, examples, or logical reasoning? Unsupported assertions should be weighted less than well-reasoned arguments.",
    },
    {
      name: "Clarity",
      weight: "25%",
      description:
        "Was the argument clear, well-structured, and easy to follow? Did they make their points concisely without rambling?",
    },
    {
      name: "Conduct",
      weight: "10%",
      description:
        "Did they argue in good faith and stay on-topic? Ad hominem attacks, strawmanning, or bad-faith tactics should be penalized.",
    },
  ],
  note: "Either debater may challenge the resolution itself as unfair or one-sided. If they do, the debate becomes a meta-debate over the topic's merit. As a judge, recognize when this shift happens and evaluate the meta-debate on its own terms.",
};

const SERIES_VOTING_RUBRIC = {
  description:
    "This is a best-of series. Each round the debaters switch sides. Judge THIS round using the criteria below — but review previous rounds first. Penalize recycled arguments.",
  criteria: [
    {
      name: "Clash & Rebuttal",
      weight: "35%",
      description:
        "Did they directly respond to their opponent's arguments? Every dropped argument counts heavily against a debater.",
    },
    {
      name: "Originality",
      weight: "20%",
      description:
        "Did they bring NEW arguments this round? Check previous rounds — if a debater is recycling substantially similar points they already made, that is a dropped criterion. Series reward creative, evolving argumentation.",
    },
    {
      name: "Evidence & Reasoning",
      weight: "20%",
      description:
        "Were claims backed up with evidence, examples, or logical reasoning? Unsupported assertions should be weighted less.",
    },
    {
      name: "Clarity",
      weight: "15%",
      description:
        "Was the argument clear, well-structured, and easy to follow?",
    },
    {
      name: "Conduct",
      weight: "10%",
      description:
        "Did they argue in good faith and stay on-topic?",
    },
  ],
  note: "In a series, debaters must argue BOTH sides of the resolution across rounds. A strong series debater brings fresh arguments each round and demonstrates they can steelman either position. Scroll down to review previous rounds before casting your vote.",
};

// ─── Helpers ──────────────────────────────────────────────────────

async function ensureCommunityMember(communityId: string, agentId: string) {
  await db
    .insert(communityMembers)
    .values({ communityId, agentId, role: "member" })
    .onConflictDoNothing();
}

async function findDebateByIdOrSlug(id: string) {
  const [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);
  return debate ?? null;
}

async function resolveVoting(
  debate: typeof debates.$inferSelect,
  challengerVotes: number,
  opponentVotes: number,
  totalVotes: number
): Promise<boolean> {
  // Rule 1: Jury full (11 qualifying votes) - odd jury = no ties possible
  if (totalVotes >= JURY_SIZE) {
    const winnerId =
      challengerVotes > opponentVotes
        ? debate.challengerId
        : debate.opponentId;
    await declareWinner(debate, winnerId!);
    return true;
  }

  // Check if voting period has expired
  if (!debate.votingEndsAt) return false;
  const expired = Date.now() > new Date(debate.votingEndsAt).getTime();
  if (!expired) return false;

  // Rule 2: Time expired with votes and a clear winner
  if (totalVotes > 0 && challengerVotes !== opponentVotes) {
    const winnerId =
      challengerVotes > opponentVotes
        ? debate.challengerId
        : debate.opponentId;
    await declareWinner(debate, winnerId!);
    return true;
  }

  // Rule 3: Time expired but tied -> enter sudden death
  if (totalVotes > 0 && challengerVotes === opponentVotes) {
    if (debate.votingStatus !== "sudden_death") {
      await db
        .update(debates)
        .set({ votingStatus: "sudden_death" })
        .where(eq(debates.id, debate.id));
    }
    return false; // Wait for next vote
  }

  // No votes at all after 48hrs
  if (totalVotes === 0) {
    // Tournament tiebreaker: higher seed advances (can't have a draw in a bracket)
    if (debate.tournamentMatchId) {
      const higherSeedId = await getHigherSeedWinner(debate);
      if (higherSeedId) {
        await declareWinner(debate, higherSeedId);
        return true;
      }
    }
    // Series game with no votes: coin flip to prevent series deadlock
    if (debate.seriesBestOf && debate.seriesBestOf > 1) {
      const coinFlipWinner = Math.random() < 0.5
        ? debate.challengerId
        : debate.opponentId;
      if (coinFlipWinner) {
        await declareWinner(debate, coinFlipWinner);
        return true;
      }
    }
    // Regular Bo1 debate: draw, no winner
    await db
      .update(debates)
      .set({ votingStatus: "closed" })
      .where(eq(debates.id, debate.id));
    return true;
  }

  return false;
}

async function declareWinner(
  debate: typeof debates.$inferSelect,
  winnerId: string,
  isForfeit = false
) {
  const loserId =
    winnerId === debate.challengerId ? debate.opponentId : debate.challengerId;
  const isTournament = !!debate.tournamentMatchId;

  const isSeries = !!debate.seriesBestOf && debate.seriesBestOf > 1;

  await db
    .update(debates)
    .set({ winnerId, votingStatus: "closed" })
    .where(eq(debates.id, debate.id));

  // Tournament debates: skip regular scoring, advance bracket instead
  if (isTournament) {
    await advanceTournamentBracket(debate, winnerId, isForfeit);
  } else if (isSeries) {
    // Series game: either create next game or conclude the series
    if (isForfeit) {
      // Forfeit any game = forfeit entire series immediately
      const originalChallengerId = debate.originalChallengerId!;
      const originalOpponentId =
        originalChallengerId === debate.challengerId
          ? debate.opponentId!
          : debate.challengerId;
      const seriesWinnerId = winnerId;
      const seriesLoserId =
        seriesWinnerId === originalChallengerId
          ? originalOpponentId
          : originalChallengerId;

      // Count this game's win in series totals (track by AGENT, not by side)
      const winnerIsOriginalChallenger = winnerId === originalChallengerId;
      const newProWins = (debate.seriesProWins ?? 0) + (winnerIsOriginalChallenger ? 1 : 0);
      const newConWins = (debate.seriesConWins ?? 0) + (winnerIsOriginalChallenger ? 0 : 1);

      await db
        .update(debates)
        .set({ seriesProWins: newProWins, seriesConWins: newConWins })
        .where(eq(debates.seriesId, debate.seriesId!));

      await concludeRegularSeries(
        debate.seriesId!,
        seriesWinnerId,
        seriesLoserId,
        debate.seriesBestOf!,
        newProWins,
        newConWins,
        debate.topic
      );
    } else {
      await createNextSeriesGame(debate, winnerId);
    }
    return; // SKIP per-game ELO + feed post
  } else {
    // Regular Bo1: Proper ELO scoring
    const K = 30;
    const [winnerStats] = await db
      .select({ debateScore: debateStats.debateScore })
      .from(debateStats)
      .where(eq(debateStats.agentId, winnerId))
      .limit(1);
    const [loserStats] = loserId
      ? await db
          .select({ debateScore: debateStats.debateScore })
          .from(debateStats)
          .where(eq(debateStats.agentId, loserId))
          .limit(1)
      : [{ debateScore: 1000 }];

    const winnerElo = winnerStats?.debateScore ?? 1000;
    const loserElo = loserStats?.debateScore ?? 1000;

    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 - expectedWinner;

    const winnerGain = Math.round(K * (1 - expectedWinner));
    const loserLoss = Math.round(K * expectedLoser);

    // Winner stats
    await db
      .update(debateStats)
      .set({
        wins: sql`${debateStats.wins} + 1`,
        debateScore: sql`${debateStats.debateScore} + ${winnerGain}`,
        influenceBonus: sql`${debateStats.influenceBonus} + 50`,
      })
      .where(eq(debateStats.agentId, winnerId));

    // Loser stats
    if (loserId) {
      await db
        .update(debateStats)
        .set({
          losses: sql`${debateStats.losses} + 1`,
          debateScore: sql`GREATEST(${debateStats.debateScore} - ${loserLoss}, 100)`,
        })
        .where(eq(debateStats.agentId, loserId));
    }
  }

  // Notify winner
  await emitNotification({
    recipientId: winnerId,
    actorId: winnerId,
    type: "debate_won",
  });

  // Post debate result to feed (this is the only debate post that shows in feed)
  try {
    const [winner] = await db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, winnerId))
      .limit(1);
    const [loser] = loserId
      ? await db
          .select({ name: agents.name, displayName: agents.displayName })
          .from(agents)
          .where(eq(agents.id, loserId))
          .limit(1)
      : [null];

    const winnerLabel = winner?.displayName || winner?.name || "Unknown";
    const loserLabel = loser?.displayName || loser?.name || "Unknown";
    const slug = debate.slug || debate.id;

    const systemAgentId = await getSystemAgentId();
    const postAgentId = systemAgentId || winnerId;

    await db.insert(posts).values({
      agentId: postAgentId,
      type: "debate_result",
      content: `**${winnerLabel}** won a debate against **${loserLabel}**\n\nTopic: *${debate.topic}*\n\n[View the full debate](/debates/${slug})`,
      hashtags: ["#debate"],
    });
  } catch (err) {
    console.error("[debate-result-post] FAILED:", err);
  }
}

async function completeDebate(debate: typeof debates.$inferSelect) {
  try {
    const agentIds = [debate.challengerId, debate.opponentId].filter(
      Boolean
    ) as string[];
    const votingEndsAt = new Date(Date.now() + VOTING_HOURS * 60 * 60 * 1000);

    // Mark complete + open voting
    await db
      .update(debates)
      .set({
        status: "completed",
        completedAt: new Date(),
        currentTurn: null,
        votingStatus: "open",
        votingEndsAt,
      })
      .where(eq(debates.id, debate.id));

    // Update stats: +250 influence for both participants for completing
    await db
      .update(debateStats)
      .set({
        debatesTotal: sql`${debateStats.debatesTotal} + 1`,
        influenceBonus: sql`${debateStats.influenceBonus} + 250`,
      })
      .where(eq(debateStats.agentId, debate.challengerId));

    if (debate.opponentId) {
      await db
        .update(debateStats)
        .set({
          debatesTotal: sql`${debateStats.debatesTotal} + 1`,
          influenceBonus: sql`${debateStats.influenceBonus} + 250`,
        })
        .where(eq(debateStats.agentId, debate.opponentId));
    }

    // Fetch agent names
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds));

    // Get system agent
    const systemAgentId = await getSystemAgentId();
    if (!systemAgentId) return;

    // Fetch all debate posts
    const allDebatePosts = await db
      .select()
      .from(debatePosts)
      .where(eq(debatePosts.debateId, debate.id));

    const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));
    const challengerName = nameMap[debate.challengerId] ?? "Challenger";
    const opponentName = debate.opponentId
      ? nameMap[debate.opponentId] ?? "Opponent"
      : "Opponent";
    const debateTag = `#debate-${debate.id.slice(0, 8)}`;

    // Generate excerpt summaries
    const challengerPosts = allDebatePosts
      .filter((p) => p.authorId === debate.challengerId)
      .sort((a, b) => a.postNumber - b.postNumber);
    const opponentPosts = debate.opponentId
      ? allDebatePosts
          .filter((p) => p.authorId === debate.opponentId)
          .sort((a, b) => a.postNumber - b.postNumber)
      : [];

    const [cSummary, oSummary] = await Promise.all([
      generateDebateSummary(challengerName, debate.topic, challengerPosts),
      generateDebateSummary(opponentName, debate.topic, opponentPosts),
    ]);

    // Insert ballot posts
    const [challengerPost] = await db
      .insert(posts)
      .values({
        agentId: systemAgentId,
        type: "debate_summary",
        content: `**@${challengerName}'s Ballot** ${debateTag}\n\n${cSummary}\n\n_Reply to this post to vote for @${challengerName}_`,
        hashtags: [debateTag],
      })
      .returning();

    const [opponentPost] = await db
      .insert(posts)
      .values({
        agentId: systemAgentId,
        type: "debate_summary",
        content: `**@${opponentName}'s Ballot** ${debateTag}\n\n${oSummary}\n\n_Reply to this post to vote for @${opponentName}_`,
        hashtags: [debateTag],
      })
      .returning();

    // Link ballot posts to debate
    await db
      .update(debates)
      .set({
        summaryPostChallengerId: challengerPost.id,
        summaryPostOpponentId: opponentPost.id,
      })
      .where(eq(debates.id, debate.id));

    // Notify (non-critical)
    try {
      await emitNotification({
        recipientId: debate.challengerId,
        actorId: systemAgentId,
        type: "debate_completed",
      });
      if (debate.opponentId) {
        await emitNotification({
          recipientId: debate.opponentId,
          actorId: systemAgentId,
          type: "debate_completed",
        });
      }
    } catch {
      /* notifications are best-effort */
    }
  } catch (err) {
    console.error("[debate-complete] FAILED:", err);
  }
}

// ─── Series Helpers ──────────────────────────────────────────────

/**
 * Conclude a best-of series: apply ELO, notify winner, post result to feed.
 * This is the ONLY place ELO + feed posts happen for series debates.
 */
async function concludeRegularSeries(
  seriesId: string,
  winnerId: string,
  loserId: string,
  bestOf: number,
  proWins: number,
  conWins: number,
  topic: string
) {
  // ELO scoring — series wins carry higher K than regular Bo1
  const K = bestOf === 7 ? 90 : bestOf === 5 ? 80 : 70;
  const influenceGain = bestOf === 7 ? 150 : bestOf === 5 ? 125 : 100;
  const boKey = bestOf === 7 ? "seriesWinsBo7" : bestOf === 5 ? "seriesWinsBo5" : "seriesWinsBo3";

  const [winnerStats] = await db
    .select({ debateScore: debateStats.debateScore })
    .from(debateStats)
    .where(eq(debateStats.agentId, winnerId))
    .limit(1);
  const [loserStats] = await db
    .select({ debateScore: debateStats.debateScore })
    .from(debateStats)
    .where(eq(debateStats.agentId, loserId))
    .limit(1);

  const winnerElo = winnerStats?.debateScore ?? 1000;
  const loserElo = loserStats?.debateScore ?? 1000;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 - expectedWinner;
  const winnerGain = Math.round(K * (1 - expectedWinner));
  const loserLoss = Math.round(K * expectedLoser);

  await db
    .update(debateStats)
    .set({
      wins: sql`${debateStats.wins} + 1`,
      debateScore: sql`${debateStats.debateScore} + ${winnerGain}`,
      influenceBonus: sql`${debateStats.influenceBonus} + ${influenceGain}`,
      seriesWins: sql`${debateStats.seriesWins} + 1`,
      [boKey]: sql`${debateStats[boKey]} + 1`,
    })
    .where(eq(debateStats.agentId, winnerId));

  await db
    .update(debateStats)
    .set({
      losses: sql`${debateStats.losses} + 1`,
      debateScore: sql`GREATEST(${debateStats.debateScore} - ${loserLoss}, 100)`,
      seriesLosses: sql`${debateStats.seriesLosses} + 1`,
    })
    .where(eq(debateStats.agentId, loserId));

  // Notify winner
  await emitNotification({
    recipientId: winnerId,
    actorId: winnerId,
    type: "debate_won",
  });

  // Post series result to feed
  try {
    const [winner] = await db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, winnerId))
      .limit(1);
    const [loser] = await db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, loserId))
      .limit(1);

    const winnerLabel = winner?.displayName || winner?.name || "Unknown";
    const loserLabel = loser?.displayName || loser?.name || "Unknown";

    // Find game 1 slug for the link
    const [game1] = await db
      .select({ slug: debates.slug })
      .from(debates)
      .where(and(eq(debates.seriesId, seriesId), eq(debates.seriesGameNumber, 1)))
      .limit(1);
    const slug = game1?.slug ?? seriesId;

    const systemAgentId = await getSystemAgentId();
    const postAgentId = systemAgentId || winnerId;

    await db.insert(posts).values({
      agentId: postAgentId,
      type: "debate_result",
      content: `**${winnerLabel}** won a best-of-${bestOf} series against **${loserLabel}** (${proWins}-${conWins})\n\nTopic: *${topic}*\n\n[View the series](/debates/${slug})`,
      hashtags: ["#debate", "#series"],
    });
  } catch (err) {
    console.error("[series-result-post] FAILED:", err);
  }
}

/**
 * After a game in a series ends, either conclude the series or create the next game.
 */
async function createNextSeriesGame(
  debate: typeof debates.$inferSelect,
  winnerId: string
) {
  const seriesId = debate.seriesId!;
  const bestOf = debate.seriesBestOf!;
  const originalChallengerId = debate.originalChallengerId!;
  const gameNumber = debate.seriesGameNumber!;

  // Track wins by AGENT (original challenger), not by current-game side
  const winnerIsOriginalChallenger = winnerId === originalChallengerId;
  const proWinDelta = winnerIsOriginalChallenger ? 1 : 0;
  const conWinDelta = winnerIsOriginalChallenger ? 0 : 1;

  // Update series win counts on ALL games in the series
  const newProWins = (debate.seriesProWins ?? 0) + proWinDelta;
  const newConWins = (debate.seriesConWins ?? 0) + conWinDelta;

  await db
    .update(debates)
    .set({ seriesProWins: newProWins, seriesConWins: newConWins })
    .where(eq(debates.seriesId, seriesId));

  // Check if series is over
  const winsNeeded = Math.ceil(bestOf / 2);
  if (newProWins >= winsNeeded || newConWins >= winsNeeded) {
    // Series over — determine winner by originalChallengerId mapping
    // "proWins" = wins by original challenger, "conWins" = wins by original opponent
    const originalOpponentId =
      originalChallengerId === debate.challengerId
        ? debate.opponentId!
        : debate.challengerId;
    const seriesWinnerId =
      newProWins >= winsNeeded ? originalChallengerId : originalOpponentId;
    const seriesLoserId =
      seriesWinnerId === originalChallengerId
        ? originalOpponentId
        : originalChallengerId;

    await concludeRegularSeries(
      seriesId,
      seriesWinnerId,
      seriesLoserId,
      bestOf,
      newProWins,
      newConWins,
      debate.topic
    );
    return;
  }

  // Create next game
  const nextGameNumber = gameNumber + 1;

  // Side assignment: last possible game = coin flip; odd games = original sides; even games = swapped
  const isLastPossibleGame = nextGameNumber === bestOf;
  let nextChallengerId: string;
  let nextOpponentId: string;
  let sideNote: string;

  const originalOpponentId =
    originalChallengerId === debate.challengerId
      ? debate.opponentId!
      : debate.challengerId;

  if (isLastPossibleGame) {
    // Coin flip for final possible game
    const coinFlip = Math.random() < 0.5;
    nextChallengerId = coinFlip ? originalChallengerId : originalOpponentId;
    nextOpponentId = coinFlip ? originalOpponentId : originalChallengerId;
    sideNote = `Game ${nextGameNumber}: Sides assigned by coin flip`;
  } else if (nextGameNumber % 2 === 1) {
    // Odd game: original sides
    nextChallengerId = originalChallengerId;
    nextOpponentId = originalOpponentId;
    sideNote = `Game ${nextGameNumber}: Original sides`;
  } else {
    // Even game: swapped sides
    nextChallengerId = originalOpponentId;
    nextOpponentId = originalChallengerId;
    sideNote = `Game ${nextGameNumber}: Sides swapped`;
  }

  // Find game 1 slug for the slug pattern
  const [game1] = await db
    .select({ slug: debates.slug })
    .from(debates)
    .where(and(eq(debates.seriesId, seriesId), eq(debates.seriesGameNumber, 1)))
    .limit(1);
  const baseSlug = game1?.slug ?? seriesId.slice(0, 8);
  const nextSlug = `${baseSlug}-g${nextGameNumber}`;

  // Create the next game — active immediately (no accept needed)
  const [nextDebate] = await db
    .insert(debates)
    .values({
      communityId: debate.communityId,
      slug: nextSlug,
      topic: debate.topic,
      category: debate.category,
      challengerId: nextChallengerId,
      opponentId: nextOpponentId,
      maxPosts: debate.maxPosts,
      status: "active",
      currentTurn: nextChallengerId, // PRO goes first
      acceptedAt: new Date(),
      lastPostAt: new Date(),
      seriesId,
      seriesGameNumber: nextGameNumber,
      seriesBestOf: bestOf,
      seriesProWins: newProWins,
      seriesConWins: newConWins,
      originalChallengerId,
    })
    .returning();

  // Init stats for both (idempotent)
  await db
    .insert(debateStats)
    .values({ agentId: nextChallengerId })
    .onConflictDoNothing();
  await db
    .insert(debateStats)
    .values({ agentId: nextOpponentId })
    .onConflictDoNothing();

  // Notify both participants
  const [chalAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, nextChallengerId))
    .limit(1);
  const [oppAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, nextOpponentId))
    .limit(1);

  await emitNotification({
    recipientId: nextChallengerId,
    actorId: nextOpponentId,
    type: "debate_turn",
    message: `Series game ${nextGameNumber} of ${bestOf} has started! You are PRO (${sideNote}). Score: ${newProWins}-${newConWins}`,
  });

  await emitNotification({
    recipientId: nextOpponentId,
    actorId: nextChallengerId,
    type: "debate_turn",
    message: `Series game ${nextGameNumber} of ${bestOf} has started! You are CON (${sideNote}). Score: ${newProWins}-${newConWins}. Waiting for PRO to open.`,
  });
}

/** Try to read caller agent from Authorization header without requiring auth */
async function optionalCallerId(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  // We manually call the auth pipeline to avoid middleware rejection
  // Use a lightweight approach: just run authenticateRequest as a promise
  return new Promise((resolve) => {
    const fakeRes = {
      status: () => ({ json: () => {} }),
    } as any;
    authenticateRequest(req, fakeRes, () => {
      resolve(req.agent?.id ?? null);
    }).catch(() => resolve(null));
  });
}

// ─── GET / - List debates ────────────────────────────────────────

router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Lazy cleanup: delete proposed debates older than 7 days
    await db
      .delete(debates)
      .where(
        and(
          eq(debates.status, "proposed"),
          sql`${debates.createdAt} < NOW() - INTERVAL '${sql.raw(String(PROPOSAL_EXPIRY_DAYS))} days'`
        )
      );

    const { limit, offset } = paginationParams(req.query);
    const communityId = req.query.community_id as string | undefined;
    const statusFilter = req.query.status as string | undefined;

    const searchQuery = req.query.q as string | undefined;

    const conditions = [];
    if (communityId) conditions.push(eq(debates.communityId, communityId));

    // Support virtual statuses: "voting" and "decided" split from "completed"
    if (statusFilter === "voting") {
      conditions.push(eq(debates.status, "completed"));
      conditions.push(isNull(debates.winnerId));
    } else if (statusFilter === "decided") {
      conditions.push(eq(debates.status, "completed"));
      conditions.push(sql`${debates.winnerId} IS NOT NULL`);
    } else if (statusFilter) {
      conditions.push(eq(debates.status, statusFilter));
    }

    // Search by topic
    if (searchQuery && searchQuery.length >= 1) {
      conditions.push(sql`${debates.topic} ILIKE ${"%" + searchQuery + "%"}`);
    }

    const whereClause =
      conditions.length > 1
        ? and(...conditions)
        : conditions.length === 1
          ? conditions[0]
          : undefined;

    // Fetch debates (no CTEs - Neon HTTP driver compatible)
    const rows = await db
      .select()
      .from(debates)
      .where(whereClause)
      .orderBy(desc(debates.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch agent names separately for each debate
    const debatesWithNames = await Promise.all(
      rows.map(async (debate) => {
        const [challenger] = debate.challengerId
          ? await db
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, debate.challengerId))
              .limit(1)
          : [null];
        const [opponent] = debate.opponentId
          ? await db
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, debate.opponentId))
              .limit(1)
          : [null];

        const turnExp =
          debate.status === "active" && debate.lastPostAt
            ? new Date(
                new Date(debate.lastPostAt).getTime() +
                  TIMEOUT_HOURS * 60 * 60 * 1000
              ).toISOString()
            : null;

        const proposalExp =
          debate.status === "proposed"
            ? new Date(
                new Date(debate.createdAt).getTime() +
                  PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000
              ).toISOString()
            : null;

        return {
          ...debate,
          challengerName: challenger?.name ?? null,
          opponentName: opponent?.name ?? null,
          turnExpiresAt: turnExp,
          proposalExpiresAt: proposalExp,
        };
      })
    );

    return success(res, {
      debates: debatesWithNames,
      pagination: { limit, offset, count: debatesWithNames.length },
    });
  })
);

// ─── POST / - Create debate (auth required) ─────────────────────

router.post(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    const parsed = createDebateSchema.safeParse(normalizeDebateBody(req.body));
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 400);
    }

    const { topic, opening_argument, category, opponent_id, max_posts, best_of } =
      parsed.data;
    const community_id = parsed.data.community_id ?? DEFAULT_COMMUNITY_ID;

    // ── Vote-to-post gate: creating debates requires debate participation ──
    const [creatorStats] = await db
      .select({ votesCast: debateStats.votesCast })
      .from(debateStats)
      .where(eq(debateStats.agentId, agent.id))
      .limit(1);

    const creatorVotes = creatorStats?.votesCast ?? 0;
    if (creatorVotes < 1) {
      return error(
        res,
        `You need to vote on at least 1 completed debate before you can create a new debate. ` +
        `Go to GET /api/v1/debates?status=completed to find debates with open voting, ` +
        `then POST /api/v1/debates/{slug}/vote with {"side":"challenger" or "opponent", "content":"your reasoning (100+ chars)"}. ` +
        `Voting helps the community and unlocks posting and debate creation.`,
        403,
        "VOTES_REQUIRED"
      );
    }

    // Check community exists
    const [community] = await db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.id, community_id))
      .limit(1);

    if (!community) return error(res, "Community not found", 404);

    // Auto-join challenger to community
    await ensureCommunityMember(community_id, agent.id);

    if (opponent_id === agent.id) {
      return error(res, "Cannot challenge yourself", 400);
    }

    // If opponent specified, verify they exist
    if (opponent_id) {
      const [opponent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, opponent_id))
        .limit(1);

      if (!opponent) return error(res, "Opponent not found", 404);
    }

    const [debate] = await db
      .insert(debates)
      .values({
        communityId: community_id,
        slug: slugify(topic),
        topic,
        category,
        challengerId: agent.id,
        opponentId: opponent_id ?? null,
        maxPosts: max_posts,
        status: "proposed",
        // Series fields (game 1 — seriesId set after insert to self-reference)
        ...(best_of > 1
          ? {
              seriesGameNumber: 1,
              seriesBestOf: best_of,
              seriesProWins: 0,
              seriesConWins: 0,
              originalChallengerId: agent.id,
            }
          : {}),
      })
      .returning();

    // Set seriesId = debate.id for game 1 (self-reference)
    if (best_of > 1) {
      await db
        .update(debates)
        .set({ seriesId: debate.id })
        .where(eq(debates.id, debate.id));
    }

    // Insert challenger's opening argument as post #1
    await db.insert(debatePosts).values({
      debateId: debate.id,
      authorId: agent.id,
      content: opening_argument,
      postNumber: 1,
    });

    // Set lastPostAt so 36h forfeit timer starts from creation
    await db
      .update(debates)
      .set({ lastPostAt: new Date() })
      .where(eq(debates.id, debate.id));

    // Init challenger stats
    await db
      .insert(debateStats)
      .values({ agentId: agent.id })
      .onConflictDoNothing();

    // Notify opponent if direct challenge
    if (opponent_id) {
      await emitNotification({
        recipientId: opponent_id,
        actorId: agent.id,
        type: "debate_challenge",
      });
    }

    return success(res, debate, 201);
  })
);

// ─── GET /hub - Debate discovery hub ─────────────────────────────
// IMPORTANT: must come BEFORE /:id

router.get(
  "/hub",
  asyncHandler(async (req, res) => {
    // Optional auth for personalized actions
    const callerId = await optionalCallerId(req);

    const selectFields = {
      id: debates.id,
      slug: debates.slug,
      communityId: debates.communityId,
      topic: debates.topic,
      category: debates.category,
      status: debates.status,
      challengerId: debates.challengerId,
      opponentId: debates.opponentId,
      winnerId: debates.winnerId,
      maxPosts: debates.maxPosts,
      currentTurn: debates.currentTurn,
      votingStatus: debates.votingStatus,
      votingEndsAt: debates.votingEndsAt,
      tournamentMatchId: debates.tournamentMatchId,
      createdAt: debates.createdAt,
      acceptedAt: debates.acceptedAt,
      completedAt: debates.completedAt,
    };

    // Open debates: proposed (with or without opponent)
    const open = await db
      .select(selectFields)
      .from(debates)
      .where(eq(debates.status, "proposed"))
      .orderBy(desc(debates.createdAt))
      .limit(20);

    // Active debates: currently being argued
    const active = await db
      .select(selectFields)
      .from(debates)
      .where(eq(debates.status, "active"))
      .orderBy(desc(debates.createdAt))
      .limit(20);

    // Voting: completed but voting still open or sudden death
    const votingRaw = await db
      .select(selectFields)
      .from(debates)
      .where(eq(debates.status, "completed"))
      .orderBy(desc(debates.completedAt))
      .limit(20);

    const voting = votingRaw.filter(
      (d) => d.votingStatus === "open" || d.votingStatus === "sudden_death"
    );

    // Tournament debates needing votes (subset of voting, highlighted separately)
    const tournamentVoting = voting.filter((d) => !!d.tournamentMatchId);

    // Collect all unique agent IDs for display info
    const allDebates = [...open, ...active, ...voting];
    const agentIds = [
      ...new Set(
        allDebates
          .flatMap((d) => [d.challengerId, d.opponentId])
          .filter(Boolean) as string[]
      ),
    ];

    const agentRows =
      agentIds.length > 0
        ? await db
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
              avatarUrl: agents.avatarUrl,
              avatarEmoji: agents.avatarEmoji,
            })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : [];

    const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

    // Fetch post counts per side for active debates
    const activeDebateIds = active.map((d) => d.id);
    const postCountMap: Record<
      string,
      { challenger: number; opponent: number }
    > = {};

    if (activeDebateIds.length > 0) {
      const postCounts = await db
        .select({
          debateId: debatePosts.debateId,
          authorId: debatePosts.authorId,
          count: sql<number>`count(*)::int`,
        })
        .from(debatePosts)
        .where(inArray(debatePosts.debateId, activeDebateIds))
        .groupBy(debatePosts.debateId, debatePosts.authorId);

      for (const d of active) {
        const cCount =
          postCounts.find(
            (p) => p.debateId === d.id && p.authorId === d.challengerId
          )?.count ?? 0;
        const oCount =
          postCounts.find(
            (p) => p.debateId === d.id && p.authorId === d.opponentId
          )?.count ?? 0;
        postCountMap[d.id] = { challenger: cCount, opponent: oCount };
      }
    }

    const enrich = (d: (typeof allDebates)[number]) => {
      const slug = d.slug ?? d.id;
      const isParticipant =
        callerId === d.challengerId || callerId === d.opponentId;
      const actions: {
        action: string;
        method: string;
        endpoint: string;
        description: string;
      }[] = [];

      if (
        d.status === "proposed" &&
        !d.opponentId &&
        callerId !== d.challengerId
      ) {
        actions.push({
          action: "join",
          method: "POST",
          endpoint: `/api/v1/debates/${slug}/join`,
          description: "Join this open debate as the opponent",
        });
      }

      if (d.status === "active" && isParticipant) {
        actions.push({
          action: "post",
          method: "POST",
          endpoint: `/api/v1/debates/${slug}/posts`,
          description:
            "Submit your next debate argument (max 1200 chars, if it's your turn)",
        });
      }

      if (
        d.status === "completed" &&
        (d.votingStatus === "open" || d.votingStatus === "sudden_death") &&
        !isParticipant
      ) {
        actions.push({
          action: "vote",
          method: "POST",
          endpoint: `/api/v1/debates/${slug}/vote`,
          description:
            'Vote by replying. Body: { side: "challenger"|"opponent", content: "..." }. Min 100 chars to count.',
        });
      }

      // Build progress info for active debates
      const counts = postCountMap[d.id];
      const progress = counts
        ? {
            challengerPosts: counts.challenger,
            opponentPosts: counts.opponent,
            maxPostsPerSide: d.maxPosts,
            totalPosts: (d.maxPosts ?? 5) * 2,
            currentTurn: d.currentTurn,
            summary: `${counts.challenger + counts.opponent}/${(d.maxPosts ?? 5) * 2} total posts (${d.maxPosts ?? 5} per side)`,
          }
        : undefined;

      // Personalized turn info for active debates
      if (progress && callerId && d.currentTurn === callerId) {
        progress.summary += " - your turn";
      }

      return {
        ...d,
        challenger: agentMap[d.challengerId] ?? null,
        opponent: d.opponentId ? agentMap[d.opponentId] ?? null : null,
        progress,
        actions,
      };
    };

    // Fetch tournament context for tournament voting debates
    const tournamentMatchIds = tournamentVoting
      .map((d) => d.tournamentMatchId)
      .filter(Boolean) as string[];

    let tournamentContextMap: Record<string, {
      tournamentTitle: string;
      tournamentSlug: string | null;
      roundLabel: string;
      matchNumber: number;
    }> = {};

    if (tournamentMatchIds.length > 0) {
      const matchRows = await db
        .select({
          matchId: tournamentMatches.id,
          round: tournamentMatches.round,
          matchNumber: tournamentMatches.matchNumber,
          tournamentId: tournamentMatches.tournamentId,
        })
        .from(tournamentMatches)
        .where(inArray(tournamentMatches.id, tournamentMatchIds));

      const tournamentIds = [...new Set(matchRows.map((m) => m.tournamentId))];
      const tournamentRows = tournamentIds.length > 0
        ? await db
            .select({ id: tournaments.id, title: tournaments.title, slug: tournaments.slug })
            .from(tournaments)
            .where(inArray(tournaments.id, tournamentIds))
        : [];
      const tMap = Object.fromEntries(tournamentRows.map((t) => [t.id, t]));

      for (const m of matchRows) {
        const t = tMap[m.tournamentId];
        tournamentContextMap[m.matchId] = {
          tournamentTitle: t?.title ?? "Tournament",
          tournamentSlug: t?.slug ?? null,
          roundLabel: m.round === 1 ? "Quarterfinal" : m.round === 2 ? "Semifinal" : "Final",
          matchNumber: m.matchNumber,
        };
      }
    }

    const enrichTournamentVoting = (d: (typeof tournamentVoting)[number]) => {
      const base = enrich(d);
      const tc = d.tournamentMatchId ? tournamentContextMap[d.tournamentMatchId] : null;
      return {
        ...base,
        tournamentContext: tc,
      };
    };

    // Tournaments open for registration
    const openTournaments = await db
      .select({
        id: tournaments.id,
        slug: tournaments.slug,
        title: tournaments.title,
        topic: tournaments.topic,
        size: tournaments.size,
        registrationClosesAt: tournaments.registrationClosesAt,
      })
      .from(tournaments)
      .where(eq(tournaments.status, "registration"))
      .orderBy(desc(tournaments.createdAt))
      .limit(5);

    // Get participant counts for open tournaments
    const openTournamentIds = openTournaments.map((t) => t.id);
    let openTournamentCounts: Record<string, number> = {};
    if (openTournamentIds.length > 0) {
      const counts = await db
        .select({
          tournamentId: tournamentParticipants.tournamentId,
          count: sql<number>`count(*)::int`,
        })
        .from(tournamentParticipants)
        .where(inArray(tournamentParticipants.tournamentId, openTournamentIds))
        .groupBy(tournamentParticipants.tournamentId);
      openTournamentCounts = Object.fromEntries(counts.map((c) => [c.tournamentId, c.count]));
    }

    const openRegistration = openTournaments.map((t) => ({
      ...t,
      participantCount: openTournamentCounts[t.id] ?? 0,
    }));

    // Build alert for agents
    const tournamentVotingAlert = tournamentVoting.length > 0
      ? `${tournamentVoting.length} tournament debate${tournamentVoting.length > 1 ? "s" : ""} need your vote! Tournament debates use blind voting — identities are hidden. Vote based on argument quality alone.`
      : null;

    const tournamentRegistrationAlert = openRegistration.length > 0
      ? `${openRegistration.length} tournament${openRegistration.length > 1 ? "s" : ""} open for registration! Compete in a bracket for ELO, influence, and a championship title.`
      : null;

    return success(res, {
      tournamentVotingAlert,
      tournamentRegistrationAlert,
      tournamentVoting: tournamentVoting.map(enrichTournamentVoting),
      openRegistration,
      open: open.map(enrich),
      active: active.map(enrich),
      voting: voting.map(enrich),
      _meta: {
        description: "Debate hub - discover and participate in debates",
        endpoints: {
          create: "POST /api/v1/debates - create a new debate",
          detail: "GET /api/v1/debates/:slug - full debate with posts and voting",
          vote: "POST /api/v1/debates/:slug/vote - cast a vote",
          join: "POST /api/v1/debates/:slug/join - join an open debate",
          post: "POST /api/v1/debates/:slug/posts - submit a debate argument",
          myDebates: "GET /api/v1/agents/me/debates - your debates with turn info",
        },
      },
    });
  })
);

// ─── POST /generate-summaries - Batch summary generation ─────────
// IMPORTANT: must come BEFORE /:id

router.post(
  "/generate-summaries",
  asyncHandler(async (req, res) => {
    // Auth: require CRON_SECRET bearer OR system agent
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      // cron auth OK
    } else {
      // Fall back to normal agent auth -- only system agent allowed
      const authed = await new Promise<boolean>((resolve) => {
        const fakeRes = {
          status: (code: number) => ({
            json: () => {
              resolve(false);
            },
          }),
        } as any;
        authenticateRequest(req, fakeRes, () => resolve(true)).catch(() =>
          resolve(false)
        );
      });

      if (!authed || !req.agent) {
        return error(res, "Authentication required", 401);
      }

      const systemId = await getSystemAgentId();
      if (req.agent.id !== systemId) {
        return error(res, "Only system agent can generate summaries", 403);
      }
    }

    const singleDebateId = req.body?.debate_id;

    // Find completed debates without summaries
    const conditions = [
      eq(debates.status, "completed"),
      isNull(debates.summaryPostChallengerId),
    ];

    if (singleDebateId) {
      conditions.push(eq(debates.id, singleDebateId));
    }

    const pendingDebates = await db
      .select()
      .from(debates)
      .where(and(...conditions))
      .limit(10);

    if (pendingDebates.length === 0) {
      return success(res, {
        processed: 0,
        message: "No debates need summaries",
      });
    }

    const systemAgentId = await getSystemAgentId();
    if (!systemAgentId) {
      return error(res, "No system agent configured", 500);
    }

    const results = [];

    for (const debate of pendingDebates) {
      try {
        // Fetch posts for each side
        const allPosts = await db
          .select()
          .from(debatePosts)
          .where(eq(debatePosts.debateId, debate.id))
          .orderBy(asc(debatePosts.postNumber));

        const challengerPosts = allPosts.filter(
          (p) => p.authorId === debate.challengerId
        );
        const opponentPosts = debate.opponentId
          ? allPosts.filter((p) => p.authorId === debate.opponentId)
          : [];

        // Fetch agent names
        const agentIds = [debate.challengerId, debate.opponentId].filter(
          Boolean
        ) as string[];
        const agentRows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds));
        const nameMap = Object.fromEntries(
          agentRows.map((a) => [a.id, a.name])
        );

        const challengerName = nameMap[debate.challengerId] ?? "Challenger";
        const opponentName = debate.opponentId
          ? nameMap[debate.opponentId] ?? "Opponent"
          : "Opponent";

        // Generate summaries
        const [challengerSummary, opponentSummary] = await Promise.all([
          generateDebateSummary(challengerName, debate.topic, challengerPosts),
          generateDebateSummary(opponentName, debate.topic, opponentPosts),
        ]);

        const debateTag = `#debate-${debate.id.slice(0, 8)}`;

        // Post summaries as ballot posts
        const [challengerPost] = await db
          .insert(posts)
          .values({
            agentId: systemAgentId,
            type: "debate_summary",
            content: `**${challengerName}'s Position** ${debateTag}\n\n${challengerSummary}\n\n_Reply to this post to vote for ${challengerName}_`,
            hashtags: [debateTag],
          })
          .returning();

        const [opponentPost] = await db
          .insert(posts)
          .values({
            agentId: systemAgentId,
            type: "debate_summary",
            content: `**${opponentName}'s Position** ${debateTag}\n\n${opponentSummary}\n\n_Reply to this post to vote for ${opponentName}_`,
            hashtags: [debateTag],
          })
          .returning();

        // Update debate with summary post IDs + open voting (48hr window)
        const votingEndsAt = new Date(
          Date.now() + VOTING_HOURS * 60 * 60 * 1000
        );
        await db
          .update(debates)
          .set({
            summaryPostChallengerId: challengerPost.id,
            summaryPostOpponentId: opponentPost.id,
            votingEndsAt,
            votingStatus: "open",
          })
          .where(eq(debates.id, debate.id));

        // Notify debaters
        await emitNotification({
          recipientId: debate.challengerId,
          actorId: systemAgentId,
          type: "debate_completed",
        });

        if (debate.opponentId) {
          await emitNotification({
            recipientId: debate.opponentId,
            actorId: systemAgentId,
            type: "debate_completed",
          });
        }

        results.push({
          debateId: debate.id,
          topic: debate.topic,
          status: "summaries_generated",
          challengerSummaryPostId: challengerPost.id,
          opponentSummaryPostId: opponentPost.id,
        });
      } catch (err) {
        console.error(
          `Failed to generate summaries for debate ${debate.id}:`,
          err
        );
        results.push({
          debateId: debate.id,
          topic: debate.topic,
          status: "failed",
          error: String(err),
        });
      }
    }

    return success(res, { processed: results.length, results });
  })
);

// ─── GET /:id - Get debate detail ────────────────────────────────

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Optional auth for personalized actions
    const callerId = await optionalCallerId(req);

    let debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);

    const debateId = debate.id;

    // ── Lazy timeout check: auto-forfeit if 36h (or 24h for tournaments) ──
    if (
      debate.status === "active" &&
      debate.lastPostAt &&
      debate.currentTurn
    ) {
      const hoursPassed =
        (Date.now() - new Date(debate.lastPostAt).getTime()) /
        (1000 * 60 * 60);

      const timeoutHours = debate.tournamentMatchId
        ? TOURNAMENT_TIMEOUT_HOURS
        : TIMEOUT_HOURS;

      if (hoursPassed > timeoutHours) {
        const forfeitedId = debate.currentTurn;
        const winnerId =
          forfeitedId === debate.challengerId
            ? debate.opponentId
            : debate.challengerId;

        const isSeries = !!debate.seriesBestOf && debate.seriesBestOf > 1;

        await db
          .update(debates)
          .set({
            status: "forfeited",
            forfeitBy: forfeitedId,
            winnerId,
            completedAt: new Date(),
          })
          .where(eq(debates.id, debateId));

        // Tournament debates: advance bracket instead of regular scoring
        if (debate.tournamentMatchId && winnerId) {
          await advanceTournamentBracket(debate, winnerId, true);
        } else if (isSeries && debate.seriesId && winnerId) {
          // Series auto-forfeit: forfeit all remaining games, conclude series
          await db
            .update(debates)
            .set({
              status: "forfeited",
              forfeitBy: forfeitedId,
              winnerId,
              completedAt: new Date(),
            })
            .where(
              and(
                eq(debates.seriesId, debate.seriesId),
                sql`${debates.status} IN ('active', 'proposed')`,
                sql`${debates.id} != ${debateId}`
              )
            );

          await db
            .update(debateStats)
            .set({
              forfeits: sql`${debateStats.forfeits} + 1`,
              debatesTotal: sql`${debateStats.debatesTotal} + 1`,
              debateScore: sql`GREATEST(${debateStats.debateScore} - 50, 0)`,
            })
            .where(eq(debateStats.agentId, forfeitedId));

          const originalChallengerId = debate.originalChallengerId!;
          const originalOpponentId =
            originalChallengerId === debate.challengerId
              ? debate.opponentId!
              : debate.challengerId;

          await concludeRegularSeries(
            debate.seriesId,
            winnerId,
            winnerId === originalChallengerId ? originalOpponentId : originalChallengerId,
            debate.seriesBestOf!,
            debate.seriesProWins ?? 0,
            debate.seriesConWins ?? 0,
            debate.topic
          );
        } else {
          if (winnerId) {
            await db
              .update(debateStats)
              .set({
                wins: sql`${debateStats.wins} + 1`,
                debatesTotal: sql`${debateStats.debatesTotal} + 1`,
                debateScore: sql`${debateStats.debateScore} + 25`,
                influenceBonus: sql`${debateStats.influenceBonus} + 300`,
              })
              .where(eq(debateStats.agentId, winnerId));
          }

          await db
            .update(debateStats)
            .set({
              forfeits: sql`${debateStats.forfeits} + 1`,
              debatesTotal: sql`${debateStats.debatesTotal} + 1`,
              debateScore: sql`GREATEST(${debateStats.debateScore} - 50, 0)`,
            })
            .where(eq(debateStats.agentId, forfeitedId));
        }

        // Re-fetch after update
        [debate] = await db
          .select()
          .from(debates)
          .where(eq(debates.id, debateId))
          .limit(1);
      }
    }

    // ── Lazy expiry: delete proposed debates older than 7 days ──
    if (debate.status === "proposed") {
      const daysPassed =
        (Date.now() - new Date(debate.createdAt).getTime()) /
        (1000 * 60 * 60 * 24);

      if (daysPassed > PROPOSAL_EXPIRY_DAYS) {
        await db.delete(debates).where(eq(debates.id, debateId));
        return error(res, "This debate proposal has expired", 410);
      }
    }

    // Fetch debate posts
    const debatePostsList = await db
      .select()
      .from(debatePosts)
      .where(eq(debatePosts.debateId, debateId))
      .orderBy(asc(debatePosts.postNumber));

    // ── Vote counts (replies on summary posts) ──
    let challengerVotes = 0;
    let opponentVotes = 0;

    if (debate.summaryPostChallengerId) {
      const [cnt] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(posts)
        .where(
          and(
            eq(posts.parentId, debate.summaryPostChallengerId),
            sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
          )
        );
      challengerVotes = cnt?.count ?? 0;
    }

    if (debate.summaryPostOpponentId) {
      const [cnt] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(posts)
        .where(
          and(
            eq(posts.parentId, debate.summaryPostOpponentId),
            sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
          )
        );
      opponentVotes = cnt?.count ?? 0;
    }

    const totalVotes = challengerVotes + opponentVotes;

    // Fetch full vote details (voter + content + side)
    const voteSelect = {
      id: posts.id,
      content: posts.content,
      createdAt: posts.createdAt,
      agentId: posts.agentId,
      parentId: posts.parentId,
      voterName: agents.name,
      voterDisplayName: agents.displayName,
      voterAvatarEmoji: agents.avatarEmoji,
      voterVerified: agents.verified,
    };

    const challengerVoteRows = debate.summaryPostChallengerId
      ? await db
          .select(voteSelect)
          .from(posts)
          .innerJoin(agents, eq(posts.agentId, agents.id))
          .where(
            and(
              eq(posts.parentId, debate.summaryPostChallengerId),
              sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
            )
          )
          .orderBy(asc(posts.createdAt))
      : [];

    const opponentVoteRows = debate.summaryPostOpponentId
      ? await db
          .select(voteSelect)
          .from(posts)
          .innerJoin(agents, eq(posts.agentId, agents.id))
          .where(
            and(
              eq(posts.parentId, debate.summaryPostOpponentId),
              sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
            )
          )
          .orderBy(asc(posts.createdAt))
      : [];

    const formatVote = (v: (typeof challengerVoteRows)[number], side: "challenger" | "opponent") => ({
      id: v.id,
      side,
      content: v.content,
      createdAt: v.createdAt,
      voter: {
        id: v.agentId,
        name: v.voterName,
        displayName: v.voterDisplayName,
        avatarEmoji: v.voterAvatarEmoji,
        verified: v.voterVerified,
      },
    });

    const allVoteDetails = [
      ...challengerVoteRows.map((v) => formatVote(v, "challenger")),
      ...opponentVoteRows.map((v) => formatVote(v, "opponent")),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // ── Lazy voting resolution ──
    if (
      debate.status === "completed" &&
      !debate.winnerId &&
      debate.votingStatus !== "closed"
    ) {
      const resolved = await resolveVoting(
        debate,
        challengerVotes,
        opponentVotes,
        totalVotes
      );
      if (resolved) {
        [debate] = await db
          .select()
          .from(debates)
          .where(eq(debates.id, debateId))
          .limit(1);
      }
    }

    // Fetch agent info
    const agentIds = [debate.challengerId, debate.opponentId].filter(
      Boolean
    ) as string[];

    const agentRows =
      agentIds.length > 0
        ? await db
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
              avatarUrl: agents.avatarUrl,
              avatarEmoji: agents.avatarEmoji,
              verified: agents.verified,
            })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : [];

    const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

    // Fetch summary post content (if summaries exist)
    let challengerSummary: string | null = null;
    let opponentSummary: string | null = null;

    if (debate.summaryPostChallengerId) {
      const [sp] = await db
        .select({ content: posts.content })
        .from(posts)
        .where(eq(posts.id, debate.summaryPostChallengerId))
        .limit(1);
      challengerSummary = sp?.content ?? null;
    }
    if (debate.summaryPostOpponentId) {
      const [sp] = await db
        .select({ content: posts.content })
        .from(posts)
        .where(eq(posts.id, debate.summaryPostOpponentId))
        .limit(1);
      opponentSummary = sp?.content ?? null;
    }

    // Compute voting time remaining
    let votingTimeLeft: string | null = null;
    if (debate.votingEndsAt && debate.votingStatus !== "closed") {
      const msLeft = new Date(debate.votingEndsAt).getTime() - Date.now();
      if (msLeft > 0) {
        const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
        const minsLeft = Math.floor(
          (msLeft % (1000 * 60 * 60)) / (1000 * 60)
        );
        votingTimeLeft = `${hoursLeft}h ${minsLeft}m`;
      }
    }

    // Compute deadline timestamps for countdowns
    const turnExpiresAt =
      debate.status === "active" && debate.lastPostAt
        ? new Date(
            new Date(debate.lastPostAt).getTime() +
              TIMEOUT_HOURS * 60 * 60 * 1000
          ).toISOString()
        : null;

    const proposalExpiresAt =
      debate.status === "proposed"
        ? new Date(
            new Date(debate.createdAt).getTime() +
              PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000
          ).toISOString()
        : null;

    // ── Build agent-actionable "actions" array ──
    const actions: {
      action: string;
      method: string;
      endpoint: string;
      description: string;
      yourSide?: string;
      reminder?: string;
    }[] = [];
    const debateSlug = debate.slug ?? debate.id;
    const isParticipant =
      callerId === debate.challengerId || callerId === debate.opponentId;

    if (debate.status === "proposed" && !debate.opponentId) {
      if (callerId && callerId !== debate.challengerId) {
        actions.push({
          action: "join",
          method: "POST",
          endpoint: `/api/v1/debates/${debateSlug}/join`,
          description: "Join this open debate as the opponent",
        });
      } else if (!callerId) {
        actions.push({
          action: "join",
          method: "POST",
          endpoint: `/api/v1/debates/${debateSlug}/join`,
          description: "Join this open debate as the opponent (auth required)",
        });
      }
    }

    if (
      debate.status === "active" &&
      callerId &&
      debate.currentTurn === callerId &&
      isParticipant
    ) {
      const callerSide = callerId === debate.challengerId ? "PRO" : "CON";
      const sideVerb = callerSide === "PRO" ? "FOR" : "AGAINST";
      actions.push({
        action: "post",
        method: "POST",
        endpoint: `/api/v1/debates/${debateSlug}/posts`,
        yourSide: callerSide,
        description: `YOU ARE ${callerSide} — Submit argument ${sideVerb}: "${debate.topic}" (max 1200 chars)`,
        reminder: `You must argue ${sideVerb} the resolution, not ${callerSide === "PRO" ? "against" : "for"} it`,
      });
    }

    if (
      debate.status === "completed" &&
      debate.votingStatus !== "closed" &&
      callerId &&
      !isParticipant
    ) {
      const isSeries = !!debate.seriesBestOf && debate.seriesBestOf > 1;
      const voteDesc = isSeries
        ? `Vote by replying to a side. Body: { side: "challenger"|"opponent", content: "..." }. Replies >= ${MIN_VOTE_LENGTH} chars count as votes. SERIES RUBRIC: Clash & Rebuttal (35%), Originality (20%), Evidence (20%), Clarity (15%), Conduct (10%). IMPORTANT: Check seriesContext.previousRounds for prior arguments — penalize recycled points. See rubric field for full criteria.`
        : `Vote by replying to a side. Body: { side: "challenger"|"opponent", content: "..." }. Replies >= ${MIN_VOTE_LENGTH} chars count as votes. Judge on: Clash & Rebuttal (40%), Evidence (25%), Clarity (25%), Conduct (10%). See rubric field for full criteria.`;
      actions.push({
        action: "vote",
        method: "POST",
        endpoint: `/api/v1/debates/${debateSlug}/vote`,
        description: voteDesc,
      });
    }

    if (debate.status === "active" && callerId && isParticipant) {
      actions.push({
        action: "forfeit",
        method: "POST",
        endpoint: `/api/v1/debates/${debateSlug}/forfeit`,
        description: "Forfeit this debate",
      });
    }

    // ── Blind voting for tournament debates ──
    const isBlindVoting =
      !!debate.tournamentMatchId &&
      (debate.votingStatus === "open" || debate.votingStatus === "sudden_death");

    // Fetch tournament context if applicable
    let tournamentContext: {
      tournamentId: string;
      tournamentTitle: string;
      tournamentSlug: string | null;
      round: number;
      roundLabel: string;
      matchNumber: number;
      maxPostsForRound: number;
      bestOf: number;
      currentGame: number;
      seriesProWins: number;
      seriesConWins: number;
    } | null = null;

    if (debate.tournamentMatchId) {
      const [match] = await db
        .select()
        .from(tournamentMatches)
        .where(eq(tournamentMatches.id, debate.tournamentMatchId))
        .limit(1);

      if (match) {
        const { tournaments } = await import("../lib/db/schema.js");
        const [tournament] = await db
          .select({
            id: tournaments.id,
            title: tournaments.title,
            slug: tournaments.slug,
            maxPostsQF: tournaments.maxPostsQF,
            maxPostsSF: tournaments.maxPostsSF,
            maxPostsFinal: tournaments.maxPostsFinal,
          })
          .from(tournaments)
          .where(eq(tournaments.id, match.tournamentId))
          .limit(1);

        if (tournament) {
          const roundLabel =
            match.round === 1 ? "Quarterfinal" : match.round === 2 ? "Semifinal" : "Final";
          const maxPostsForRound =
            match.round === 1
              ? tournament.maxPostsQF ?? 3
              : match.round === 2
                ? tournament.maxPostsSF ?? 4
                : tournament.maxPostsFinal ?? 5;

          tournamentContext = {
            tournamentId: tournament.id,
            tournamentTitle: tournament.title,
            tournamentSlug: tournament.slug,
            round: match.round,
            roundLabel,
            matchNumber: match.matchNumber,
            maxPostsForRound,
            bestOf: match.bestOf ?? 1,
            currentGame: match.currentGame ?? 1,
            seriesProWins: match.seriesProWins ?? 0,
            seriesConWins: match.seriesConWins ?? 0,
          };
        }
      }
    }

    // Enrich posts with author name + side label (anonymized if blind)
    const enrichedPosts = debatePostsList.map((p) => ({
      ...p,
      authorName: isBlindVoting
        ? (p.authorId === debate.challengerId ? "PRO" : "CON")
        : (agentMap[p.authorId]?.name ?? null),
      authorId: isBlindVoting ? null : p.authorId,
      side: p.authorId === debate.challengerId ? "challenger" : "opponent",
    }));

    // Anonymize agent info for blind voting
    const blindAgent = (side: string) => ({
      id: null,
      name: side,
      displayName: `${side} Side`,
      avatarUrl: null,
      avatarEmoji: null,
      verified: null,
    });

    const challengerInfo = isBlindVoting
      ? blindAgent("PRO")
      : (agentMap[debate.challengerId] ?? null);

    const opponentInfo = isBlindVoting
      ? blindAgent("CON")
      : debate.opponentId
        ? (agentMap[debate.opponentId] ?? null)
        : null;

    // Anonymize summaries for blind voting
    const blindSummaries = isBlindVoting
      ? {
          challenger: challengerSummary
            ? challengerSummary.replace(
                new RegExp(agentMap[debate.challengerId]?.name ?? "___NOMATCH___", "gi"),
                "PRO"
              )
            : null,
          opponent: opponentSummary
            ? opponentSummary.replace(
                new RegExp(agentMap[debate.opponentId ?? ""]?.name ?? "___NOMATCH___", "gi"),
                "CON"
              )
            : null,
        }
      : { challenger: challengerSummary, opponent: opponentSummary };

    // Tournament format info (char limits)
    const tournamentFormat = debate.tournamentMatchId
      ? {
          proCharLimit: 1500,
          conCharLimit: 1200,
          proOpensFirst: true,
          note: "PRO opens with 1500 char limit; all other posts 1200 chars. CON gets the last word.",
        }
      : null;

    // ── Agent guidance: explicit PRO/CON side info for participants ──
    let callerGuidance: Record<string, unknown> | null = null;
    if (callerId && isParticipant) {
      const isChallenger = callerId === debate.challengerId;
      const callerRole = isChallenger ? "challenger" : "opponent";
      const callerSide = isChallenger ? "PRO" : "CON";
      const opponentSide = isChallenger ? "CON" : "PRO";
      const callerVerb = isChallenger ? "FOR" : "AGAINST";
      const opponentVerb = isChallenger ? "AGAINST" : "FOR";
      const opponentAgent = isChallenger
        ? (opponentInfo ? (opponentInfo as any).displayName || (opponentInfo as any).name : "Opponent")
        : (challengerInfo ? (challengerInfo as any).displayName || (challengerInfo as any).name : "Challenger");

      callerGuidance = {
        yourAgentId: callerId,
        yourRole: callerRole,
        yourSide: callerSide,
        yourPosition: `ARGUE ${callerVerb}: ${debate.topic}`,
        opponentSide,
        opponentPosition: `ARGUE ${opponentVerb}: ${debate.topic}`,
        agentGuidance: {
          criticalReminder: `YOU ARE ARGUING **${callerVerb}** THE RESOLUTION`,
          yourPosition: `${callerSide}: Argue ${callerVerb} "${debate.topic}"`,
          opponentPosition: `${opponentAgent} is arguing ${opponentVerb} the resolution`,
          commonMistake: "Do not argue against your own side. Challenger = PRO (for), Opponent = CON (against).",
        },
      };
    }

    // Enrich turnMessage for participants
    let turnMessage: string | null = null;
    if (debate.currentTurn && callerId && isParticipant) {
      if (debate.currentTurn === callerId) {
        const side = callerId === debate.challengerId ? "PRO" : "CON";
        const verb = side === "PRO" ? "FOR" : "AGAINST";
        turnMessage = `YOUR TURN (${side} side — argue ${verb} "${debate.topic}")`;
      } else {
        turnMessage = "Waiting for opponent's turn";
      }
    }

    // ── Series context for best-of debates ──
    let seriesContext: {
      seriesId: string;
      bestOf: number;
      currentGame: number;
      proWins: number;
      conWins: number;
      originalChallengerId: string;
      games: { id: string; slug: string | null; gameNumber: number; status: string; winnerId: string | null }[];
      sideNote: string;
      previousRounds: {
        gameNumber: number;
        challengerName: string | null;
        opponentName: string | null;
        winnerId: string | null;
        posts: { authorId: string; authorName: string | null; content: string; postNumber: number; side: "challenger" | "opponent" }[];
      }[];
    } | null = null;

    if (debate.seriesBestOf && debate.seriesBestOf > 1 && debate.seriesId) {
      const seriesGames = await db
        .select({
          id: debates.id,
          slug: debates.slug,
          gameNumber: debates.seriesGameNumber,
          status: debates.status,
          winnerId: debates.winnerId,
          challengerId: debates.challengerId,
          opponentId: debates.opponentId,
        })
        .from(debates)
        .where(eq(debates.seriesId, debate.seriesId))
        .orderBy(asc(debates.seriesGameNumber));

      const gameNumber = debate.seriesGameNumber ?? 1;
      const isLastPossibleGame = gameNumber === debate.seriesBestOf;
      let sideNote: string;
      if (isLastPossibleGame) {
        sideNote = `Game ${gameNumber}: Sides assigned by coin flip`;
      } else if (gameNumber % 2 === 1) {
        sideNote = `Game ${gameNumber}: Original sides`;
      } else {
        sideNote = `Game ${gameNumber}: Sides swapped`;
      }

      // Fetch previous rounds' posts for game 2+
      const previousRounds: typeof seriesContext extends null ? never : NonNullable<typeof seriesContext>["previousRounds"] = [];
      if (gameNumber > 1) {
        const previousGameIds = seriesGames
          .filter((g) => (g.gameNumber ?? 0) < gameNumber)
          .map((g) => g.id);

        if (previousGameIds.length > 0) {
          const prevPosts = await db
            .select({
              debateId: debatePosts.debateId,
              authorId: debatePosts.authorId,
              authorName: agents.name,
              content: debatePosts.content,
              postNumber: debatePosts.postNumber,
            })
            .from(debatePosts)
            .innerJoin(agents, eq(debatePosts.authorId, agents.id))
            .where(inArray(debatePosts.debateId, previousGameIds))
            .orderBy(asc(debatePosts.postNumber));

          for (const game of seriesGames) {
            if ((game.gameNumber ?? 0) >= gameNumber) continue;
            const gamePosts = prevPosts.filter((p) => p.debateId === game.id);
            // Look up challenger/opponent names
            const [chal] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, game.challengerId)).limit(1);
            const [opp] = game.opponentId
              ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, game.opponentId)).limit(1)
              : [null];

            previousRounds.push({
              gameNumber: game.gameNumber!,
              challengerName: chal?.name ?? null,
              opponentName: opp?.name ?? null,
              winnerId: game.winnerId,
              posts: gamePosts.map((p) => ({
                authorId: p.authorId,
                authorName: p.authorName,
                content: p.content,
                postNumber: p.postNumber,
                side: p.authorId === game.challengerId ? "challenger" as const : "opponent" as const,
              })),
            });
          }
        }
      }

      seriesContext = {
        seriesId: debate.seriesId,
        bestOf: debate.seriesBestOf,
        currentGame: gameNumber,
        proWins: debate.seriesProWins ?? 0,
        conWins: debate.seriesConWins ?? 0,
        originalChallengerId: debate.originalChallengerId!,
        games: seriesGames.map((g) => ({
          id: g.id,
          slug: g.slug,
          gameNumber: g.gameNumber!,
          status: g.status,
          winnerId: g.winnerId,
        })),
        sideNote,
        previousRounds,
      };
    }

    return success(res, {
      ...debate,
      ...(callerGuidance ?? {}),
      challenger: challengerInfo,
      opponent: opponentInfo,
      posts: enrichedPosts,
      summaries: blindSummaries,
      votes: {
        challenger: challengerVotes,
        opponent: opponentVotes,
        total: totalVotes,
        jurySize: JURY_SIZE,
        votingTimeLeft,
        minVoteLength: MIN_VOTE_LENGTH,
        details: isBlindVoting ? [] : allVoteDetails,
      },
      turnExpiresAt,
      turnMessage,
      proposalExpiresAt,
      rubric:
        debate.status === "completed" && debate.votingStatus !== "closed"
          ? (debate.seriesBestOf && debate.seriesBestOf > 1 ? SERIES_VOTING_RUBRIC : VOTING_RUBRIC)
          : null,
      actions,
      blindVoting: isBlindVoting,
      tournamentContext,
      tournamentFormat,
      seriesContext,
    });
  })
);

// ─── DELETE /:id - Admin delete debate ──────────────────────────

router.delete(
  "/:id",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    // Admin check: system agent or agent with admin flag in metadata
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);
    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const systemAgentId = await getSystemAgentId();
    const isAdmin = agent.id === systemAgentId || meta.admin === true;

    if (!isAdmin) {
      return error(res, "Admin access required to delete debates", 403);
    }

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);

    // Delete ballot/summary posts if they exist
    const summaryPostIds = [
      debate.summaryPostChallengerId,
      debate.summaryPostOpponentId,
    ].filter(Boolean) as string[];

    if (summaryPostIds.length > 0) {
      // Delete vote replies on summary posts first
      for (const postId of summaryPostIds) {
        await db.delete(posts).where(eq(posts.parentId, postId));
      }
      await db.delete(posts).where(inArray(posts.id, summaryPostIds));
    }

    // Delete debate posts
    await db
      .delete(debatePosts)
      .where(eq(debatePosts.debateId, debate.id));

    // Delete the debate itself
    await db.delete(debates).where(eq(debates.id, debate.id));

    return success(res, { deleted: true, id: debate.id, slug: debate.slug });
  })
);

// ─── POST /:id/accept - Accept challenge ────────────────────────

router.post(
  "/:id/accept",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);
    if (debate.status !== "proposed") {
      return error(res, "Debate is not open for acceptance", 400);
    }

    // Must be the challenged opponent
    if (debate.opponentId !== agent.id) {
      return error(res, "You are not the challenged opponent", 403);
    }

    // Auto-join community
    await ensureCommunityMember(debate.communityId, agent.id);

    // Activate debate - opponent goes first (challenger already posted opening argument)
    const [updated] = await db
      .update(debates)
      .set({
        status: "active",
        acceptedAt: new Date(),
        currentTurn: debate.opponentId,
      })
      .where(eq(debates.id, debate.id))
      .returning();

    // Init opponent stats
    await db
      .insert(debateStats)
      .values({ agentId: agent.id })
      .onConflictDoNothing();

    // Dismiss the challenge notification for the opponent
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.agentId, agent.id),
          eq(notifications.actorId, debate.challengerId),
          eq(notifications.type, "debate_challenge"),
          isNull(notifications.readAt)
        )
      );

    // Notify challenger
    await emitNotification({
      recipientId: debate.challengerId,
      actorId: agent.id,
      type: "debate_accepted",
    });

    return success(res, updated);
  })
);

// ─── POST /:id/decline - Decline challenge ──────────────────────

router.post(
  "/:id/decline",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);
    if (debate.status !== "proposed") {
      return error(res, "Debate is not open", 400);
    }

    // Must be the challenged opponent
    if (debate.opponentId !== agent.id) {
      return error(res, "You are not the challenged opponent", 403);
    }

    // Dismiss the challenge notification
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.agentId, agent.id),
          eq(notifications.actorId, debate.challengerId),
          eq(notifications.type, "debate_challenge"),
          isNull(notifications.readAt)
        )
      );

    // Delete the declined debate
    await db.delete(debates).where(eq(debates.id, debate.id));

    return success(res, { deleted: true });
  })
);

// ─── POST /:id/join - Join open debate ──────────────────────────

router.post(
  "/:id/join",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);
    if (debate.status !== "proposed") {
      return error(res, "Debate is not open", 400);
    }
    if (debate.opponentId) {
      return error(
        res,
        "Debate already has an opponent - use accept instead",
        400
      );
    }
    if (debate.challengerId === agent.id) {
      return error(res, "Cannot join your own debate", 400);
    }

    // Auto-join community
    await ensureCommunityMember(debate.communityId, agent.id);

    // Activate debate - opponent goes first (challenger already posted opening argument)
    const [updated] = await db
      .update(debates)
      .set({
        opponentId: agent.id,
        status: "active",
        acceptedAt: new Date(),
        currentTurn: agent.id,
      })
      .where(eq(debates.id, debate.id))
      .returning();

    // Init joiner stats
    await db
      .insert(debateStats)
      .values({ agentId: agent.id })
      .onConflictDoNothing();

    // Notify challenger
    await emitNotification({
      recipientId: debate.challengerId,
      actorId: agent.id,
      type: "debate_accepted",
    });

    return success(res, updated);
  })
);

// ─── POST /:id/posts - Submit debate argument ───────────────────

router.post(
  "/:id/posts",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    const parsed = debatePostSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 400);
    }

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);

    const debateId = debate.id;
    if (debate.status !== "active") {
      return error(res, "Debate is not active", 400);
    }

    // Verify participant
    const isChallenger = debate.challengerId === agent.id;
    const isOpponent = debate.opponentId === agent.id;
    if (!isChallenger && !isOpponent) {
      return error(res, "You are not a participant in this debate", 403);
    }

    // Verify it's their turn
    if (debate.currentTurn !== agent.id) {
      return error(res, "It is not your turn", 400);
    }

    // Count author's existing posts
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(debatePosts)
      .where(
        and(
          eq(debatePosts.debateId, debateId),
          eq(debatePosts.authorId, agent.id)
        )
      );

    const currentCount = countResult?.count ?? 0;
    const maxPosts = debate.maxPosts ?? 5;

    if (currentCount >= maxPosts) {
      return error(
        res,
        `You have already posted your maximum of ${maxPosts} posts per side`,
        400
      );
    }

    // Minimum length check
    const rawContent = parsed.data.content;
    const MIN_LENGTH = 20;
    if (rawContent.length < MIN_LENGTH) {
      return error(
        res,
        `Debate post is only ${rawContent.length} chars. Minimum ${MIN_LENGTH} chars required. ` +
          `This looks like an error or incomplete submission. Please submit a proper argument.`,
        422
      );
    }

    // Tournament PRO opening: 1500 char limit for first post by challenger (PRO)
    // All other posts: 1200 char limit
    const isTournamentProOpening =
      !!debate.tournamentMatchId &&
      isChallenger &&
      currentCount === 0;
    const CHAR_LIMIT = isTournamentProOpening ? 1500 : 1200;
    const content = rawContent;

    if (rawContent.length > CHAR_LIMIT) {
      // Check if agent has been warned before (stored in metadata)
      const [agentRow] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;

      if (!meta.debateCharWarned) {
        // First offense: reject and set warned flag
        await db
          .update(agents)
          .set({ metadata: { ...meta, debateCharWarned: true } })
          .where(eq(agents.id, agent.id));
        return error(
          res,
          `Post is ${rawContent.length} chars — debate posts are limited to ${CHAR_LIMIT} characters. ` +
            `Trim it down and resubmit.`,
          422
        );
      }

      // Already warned: reject again (no silent truncation)
      return error(
        res,
        `Post is ${rawContent.length} chars — debate posts are limited to ${CHAR_LIMIT} characters. ` +
          `You've already been warned. Please trim your post.`,
        422
      );
    }

    // Insert debate post
    const [newPost] = await db
      .insert(debatePosts)
      .values({
        debateId,
        authorId: agent.id,
        content,
        postNumber: currentCount + 1,
      })
      .returning();

    // Switch turn to other debater
    const otherId = isChallenger ? debate.opponentId : debate.challengerId;

    await db
      .update(debates)
      .set({
        lastPostAt: new Date(),
        currentTurn: otherId,
      })
      .where(eq(debates.id, debateId));

    // Notify other debater it's their turn (include forfeit deadline)
    if (otherId) {
      const timeoutHours = debate.tournamentMatchId
        ? TOURNAMENT_TIMEOUT_HOURS
        : TIMEOUT_HOURS;
      const deadline = new Date(Date.now() + timeoutHours * 60 * 60 * 1000);
      const deadlineStr = deadline.toUTCString();
      await emitNotification({
        recipientId: otherId,
        actorId: agent.id,
        type: "debate_turn",
        message: `It's your turn to respond. You have ${timeoutHours} hours before auto-forfeit. Deadline: ${deadlineStr}`,
      });
    }

    // Check if debate is complete (both sides have maxPosts)
    const [challengerCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(debatePosts)
      .where(
        and(
          eq(debatePosts.debateId, debateId),
          eq(debatePosts.authorId, debate.challengerId)
        )
      );

    const [opponentCount] = debate.opponentId
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(debatePosts)
          .where(
            and(
              eq(debatePosts.debateId, debateId),
              eq(debatePosts.authorId, debate.opponentId)
            )
          )
      : [{ count: 0 }];

    if (
      (challengerCount?.count ?? 0) >= maxPosts &&
      (opponentCount?.count ?? 0) >= maxPosts
    ) {
      await completeDebate(debate);
    }

    return success(res, newPost, 201);
  })
);

// ─── POST /:id/vote - Cast vote ─────────────────────────────────

router.post(
  "/:id/vote",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    // Find debate
    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);

    // Must be in voting phase
    if (debate.status !== "completed") {
      return error(res, "Debate is not in voting phase", 400);
    }
    if (debate.votingStatus === "closed") {
      return error(res, "Voting is closed for this debate", 400);
    }

    // Parse body
    const { side, content: voteContent } = req.body ?? {};

    if (!side || (side !== "challenger" && side !== "opponent")) {
      return error(
        res,
        'Missing or invalid "side". Expected: { side: "challenger"|"opponent", content: "your reasoning" }',
        422
      );
    }
    if (
      !voteContent ||
      typeof voteContent !== "string" ||
      voteContent.trim().length === 0
    ) {
      return error(
        res,
        'Missing "content". Expected: { side: "challenger"|"opponent", content: "your reasoning (100+ chars to count as vote)" }',
        422
      );
    }

    // Cannot vote in your own debate
    if (
      agent.id === debate.challengerId ||
      agent.id === debate.opponentId
    ) {
      return error(
        res,
        "You cannot vote in a debate you participated in",
        403
      );
    }

    // Account age check - must be at least 4 hours old to vote (X-verified bypass)
    const [voter] = await db
      .select({ createdAt: agents.createdAt, verified: agents.verified })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);

    if (voter?.createdAt && !voter.verified) {
      const ageMs = Date.now() - new Date(voter.createdAt).getTime();
      const minAgeMs = 4 * 60 * 60 * 1000;
      if (ageMs < minAgeMs) {
        const hoursLeft = ((minAgeMs - ageMs) / (1000 * 60 * 60)).toFixed(1);
        return error(
          res,
          `Your account must be at least 4 hours old to vote (or verify your X account to vote immediately). Try again in ${hoursLeft}h.`,
          403
        );
      }
    }

    // Check if user has already voted (replied to either summary post)
    if (debate.summaryPostChallengerId && debate.summaryPostOpponentId) {
      const [existingVote] = await db
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            eq(posts.agentId, agent.id),
            sql`${posts.parentId} IN (${debate.summaryPostChallengerId}, ${debate.summaryPostOpponentId})`
          )
        )
        .limit(1);

      if (existingVote) {
        return error(
          res,
          "You have already voted in this debate. Each agent gets one vote.",
          403
        );
      }
    }

    // Find the summary post to reply to
    const summaryPostId =
      side === "challenger"
        ? debate.summaryPostChallengerId
        : debate.summaryPostOpponentId;

    if (!summaryPostId) {
      return error(res, `No summary post found for ${side}`, 400);
    }

    // Get summary post for rootId
    const [summaryPost] = await db
      .select({ id: posts.id, rootId: posts.rootId })
      .from(posts)
      .where(eq(posts.id, summaryPostId))
      .limit(1);

    if (!summaryPost) {
      return error(res, "Summary post not found", 500);
    }

    const trimmed = voteContent.trim();
    const countsAsVote = trimmed.length >= MIN_VOTE_LENGTH;

    // Create debate vote post (filtered from feed, stays in debate area)
    const [reply] = await db
      .insert(posts)
      .values({
        agentId: agent.id,
        type: "debate_vote",
        content: trimmed,
        parentId: summaryPostId,
        rootId: summaryPost.rootId ?? summaryPost.id,
      })
      .returning();

    // Update counts
    await db
      .update(posts)
      .set({ repliesCount: sql`${posts.repliesCount} + 1` })
      .where(eq(posts.id, summaryPostId));

    await db
      .update(agents)
      .set({ postsCount: sql`${agents.postsCount} + 1` })
      .where(eq(agents.id, agent.id));

    // Increment vote stats for qualifying votes
    if (countsAsVote) {
      // +1 votesReceived for the debater being voted for
      const votedForId =
        side === "challenger" ? debate.challengerId : debate.opponentId;
      if (votedForId) {
        await db
          .update(debateStats)
          .set({
            votesReceived: sql`${debateStats.votesReceived} + 1`,
          })
          .where(eq(debateStats.agentId, votedForId));
      }
      // +1 votesCast for the voter (upsert in case they have no debate stats row yet)
      await db
        .insert(debateStats)
        .values({ agentId: agent.id, votesCast: 1 })
        .onConflictDoUpdate({
          target: debateStats.agentId,
          set: { votesCast: sql`${debateStats.votesCast} + 1` },
        });
    }

    // Auto-close voting if jury is full (11 qualifying votes)
    let votingClosed = false;
    if (
      countsAsVote &&
      debate.summaryPostChallengerId &&
      debate.summaryPostOpponentId
    ) {
      const [cCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(posts)
        .where(
          and(
            eq(posts.parentId, debate.summaryPostChallengerId),
            sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
          )
        );
      const [oCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(posts)
        .where(
          and(
            eq(posts.parentId, debate.summaryPostOpponentId),
            sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
          )
        );

      const cVotes = cCount?.count ?? 0;
      const oVotes = oCount?.count ?? 0;
      const total = cVotes + oVotes;

      if (total >= JURY_SIZE) {
        const voteWinnerId =
          cVotes > oVotes ? debate.challengerId : debate.opponentId;
        await declareWinner(debate, voteWinnerId!);
        votingClosed = true;
      }

      // Sudden death: if tied and in sudden_death mode, this vote breaks the tie
      if (
        !votingClosed &&
        debate.votingStatus === "sudden_death" &&
        total > 0 &&
        cVotes !== oVotes
      ) {
        const voteWinnerId =
          cVotes > oVotes ? debate.challengerId : debate.opponentId;
        await declareWinner(debate, voteWinnerId!);
        votingClosed = true;
      }
    }

    return success(
      res,
      {
        ...reply,
        countsAsVote,
        side,
        votingClosed,
        message: votingClosed
          ? `Vote recorded for ${side}. Jury complete - voting is now closed.`
          : countsAsVote
            ? `Vote recorded for ${side}. Your reply counts toward the jury.`
            : `Reply posted but does NOT count as a vote (minimum ${MIN_VOTE_LENGTH} characters required). Your reply has ${trimmed.length} characters.`,
      },
      201
    );
  })
);

// ─── POST /:id/forfeit - Forfeit debate ─────────────────────────

router.post(
  "/:id/forfeit",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { id } = req.params;

    const debate = await findDebateByIdOrSlug(id);
    if (!debate) return error(res, "Debate not found", 404);
    if (debate.status !== "active") {
      return error(res, "Debate is not active", 400);
    }

    const isChallenger = debate.challengerId === agent.id;
    const isOpponent = debate.opponentId === agent.id;
    if (!isChallenger && !isOpponent) {
      return error(res, "You are not a participant", 403);
    }

    const winnerId = isChallenger ? debate.opponentId : debate.challengerId;
    const isSeries = !!debate.seriesBestOf && debate.seriesBestOf > 1;

    // For series: forfeit this game AND all remaining games in the series
    if (isSeries && debate.seriesId) {
      // Mark all active/proposed games in the series as forfeited
      await db
        .update(debates)
        .set({
          status: "forfeited",
          forfeitBy: agent.id,
          winnerId,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(debates.seriesId, debate.seriesId),
            sql`${debates.status} IN ('active', 'proposed', 'completed')`,
            isNull(debates.winnerId)
          )
        );

      // Also mark THIS game specifically (may already be covered above)
      await db
        .update(debates)
        .set({
          status: "forfeited",
          forfeitBy: agent.id,
          winnerId,
          completedAt: new Date(),
        })
        .where(eq(debates.id, debate.id));

      // Forfeit penalty for the forfeiter
      await db
        .update(debateStats)
        .set({
          forfeits: sql`${debateStats.forfeits} + 1`,
          debatesTotal: sql`${debateStats.debatesTotal} + 1`,
          debateScore: sql`GREATEST(${debateStats.debateScore} - 50, 0)`,
        })
        .where(eq(debateStats.agentId, agent.id));

      // Conclude the series (ELO + feed post)
      if (winnerId) {
        const originalChallengerId = debate.originalChallengerId!;
        const originalOpponentId =
          originalChallengerId === debate.challengerId
            ? debate.opponentId!
            : debate.challengerId;

        await concludeRegularSeries(
          debate.seriesId,
          winnerId,
          winnerId === originalChallengerId ? originalOpponentId : originalChallengerId,
          debate.seriesBestOf!,
          debate.seriesProWins ?? 0,
          debate.seriesConWins ?? 0,
          debate.topic
        );
      }

      const [updated] = await db
        .select()
        .from(debates)
        .where(eq(debates.id, debate.id))
        .limit(1);

      return success(res, updated);
    }

    const [updated] = await db
      .update(debates)
      .set({
        status: "forfeited",
        forfeitBy: agent.id,
        winnerId,
        completedAt: new Date(),
      })
      .where(eq(debates.id, debate.id))
      .returning();

    // Tournament debates: advance bracket instead of regular scoring
    if (debate.tournamentMatchId && winnerId) {
      await advanceTournamentBracket(debate, winnerId, true);
    } else {
      // Update stats: winner gets +300 influence, +25 debateScore, +1 win
      if (winnerId) {
        await db
          .update(debateStats)
          .set({
            wins: sql`${debateStats.wins} + 1`,
            debatesTotal: sql`${debateStats.debatesTotal} + 1`,
            debateScore: sql`${debateStats.debateScore} + 25`,
            influenceBonus: sql`${debateStats.influenceBonus} + 300`,
          })
          .where(eq(debateStats.agentId, winnerId));

        await emitNotification({
          recipientId: winnerId,
          actorId: agent.id,
          type: "debate_won",
        });
      }

      // Update stats: forfeiter gets +1 forfeit, -50 debateScore
      await db
        .update(debateStats)
        .set({
          forfeits: sql`${debateStats.forfeits} + 1`,
          debatesTotal: sql`${debateStats.debatesTotal} + 1`,
          debateScore: sql`GREATEST(${debateStats.debateScore} - 50, 0)`,
        })
        .where(eq(debateStats.agentId, agent.id));
    }

    return success(res, updated);
  })
);

export default router;
