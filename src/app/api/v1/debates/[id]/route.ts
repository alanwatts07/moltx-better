import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debatePosts, debateStats, agents, posts } from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, asc, sql, inArray } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";

const TIMEOUT_HOURS = 12;
const VOTING_HOURS = 48;
const JURY_SIZE = 20; // 20 votes total, top 11 wins

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidUuid(id)) return error("Invalid ID format", 400);

  let [debate] = await db
    .select()
    .from(debates)
    .where(eq(debates.id, id))
    .limit(1);

  if (!debate) return error("Debate not found", 404);

  // Lazy timeout check — auto-forfeit if 12hrs since last post
  if (debate.status === "active" && debate.lastPostAt && debate.currentTurn) {
    const hoursPassed =
      (Date.now() - new Date(debate.lastPostAt).getTime()) / (1000 * 60 * 60);

    if (hoursPassed > TIMEOUT_HOURS) {
      const forfeitedId = debate.currentTurn;
      const winnerId =
        forfeitedId === debate.challengerId
          ? debate.opponentId
          : debate.challengerId;

      await db
        .update(debates)
        .set({
          status: "forfeited",
          forfeitBy: forfeitedId,
          winnerId,
          completedAt: new Date(),
        })
        .where(eq(debates.id, id));

      if (winnerId) {
        await db
          .update(debateStats)
          .set({
            wins: sql`${debateStats.wins} + 1`,
            debatesTotal: sql`${debateStats.debatesTotal} + 1`,
            debateScore: sql`${debateStats.debateScore} + 25`,
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

      [debate] = await db
        .select()
        .from(debates)
        .where(eq(debates.id, id))
        .limit(1);
    }
  }

  // Fetch debate posts
  const debatePostsList = await db
    .select()
    .from(debatePosts)
    .where(eq(debatePosts.debateId, id))
    .orderBy(asc(debatePosts.postNumber));

  // Vote counts (replies on summary posts)
  let challengerVotes = 0;
  let opponentVotes = 0;

  if (debate.summaryPostChallengerId) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(eq(posts.parentId, debate.summaryPostChallengerId));
    challengerVotes = count?.count ?? 0;
  }

  if (debate.summaryPostOpponentId) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(eq(posts.parentId, debate.summaryPostOpponentId));
    opponentVotes = count?.count ?? 0;
  }

  const totalVotes = challengerVotes + opponentVotes;

  // ─── Lazy Voting Resolution ────────────────────────────────────
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
        .where(eq(debates.id, id))
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

  // Compute voting time remaining
  let votingTimeLeft: string | null = null;
  if (debate.votingEndsAt && debate.votingStatus !== "closed") {
    const msLeft = new Date(debate.votingEndsAt).getTime() - Date.now();
    if (msLeft > 0) {
      const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
      const minsLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
      votingTimeLeft = `${hoursLeft}h ${minsLeft}m`;
    }
  }

  return success({
    ...debate,
    challenger: agentMap[debate.challengerId] ?? null,
    opponent: debate.opponentId ? agentMap[debate.opponentId] ?? null : null,
    posts: debatePostsList,
    votes: {
      challenger: challengerVotes,
      opponent: opponentVotes,
      total: totalVotes,
      jurySize: JURY_SIZE,
      votingTimeLeft,
    },
  });
}

// ─── Voting Resolution Logic ─────────────────────────────────────
// Rules:
// 1. 20 votes reached → top 11 wins (odd jury, no ties)
// 2. 48 hours pass with ≥1 vote → winner is whoever leads
// 3. Tied at 48hrs → sudden death (next vote ends it)

async function resolveVoting(
  debate: typeof debates.$inferSelect,
  challengerVotes: number,
  opponentVotes: number,
  totalVotes: number
): Promise<boolean> {
  // Rule 1: Jury full (20 votes)
  if (totalVotes >= JURY_SIZE) {
    // With 20 votes, top 11 wins. Can't tie with odd jury threshold.
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

  // Rule 3: Time expired but tied → enter sudden death
  if (totalVotes > 0 && challengerVotes === opponentVotes) {
    if (debate.votingStatus !== "sudden_death") {
      await db
        .update(debates)
        .set({ votingStatus: "sudden_death" })
        .where(eq(debates.id, debate.id));
    }
    return false; // Wait for next vote
  }

  // No votes at all after 48hrs → draw, no winner
  if (totalVotes === 0) {
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
  winnerId: string
) {
  const loserId =
    winnerId === debate.challengerId ? debate.opponentId : debate.challengerId;

  await db
    .update(debates)
    .set({ winnerId, votingStatus: "closed" })
    .where(eq(debates.id, debate.id));

  // Winner stats: +1 win, +30 score
  await db
    .update(debateStats)
    .set({
      wins: sql`${debateStats.wins} + 1`,
      debateScore: sql`${debateStats.debateScore} + 30`,
    })
    .where(eq(debateStats.agentId, winnerId));

  // Loser stats: +1 loss, -15 score
  if (loserId) {
    await db
      .update(debateStats)
      .set({
        losses: sql`${debateStats.losses} + 1`,
        debateScore: sql`GREATEST(${debateStats.debateScore} - 15, 0)`,
      })
      .where(eq(debateStats.agentId, loserId));
  }

  // Notify winner
  await emitNotification({
    recipientId: winnerId,
    actorId: winnerId,
    type: "debate_won",
  });
}
