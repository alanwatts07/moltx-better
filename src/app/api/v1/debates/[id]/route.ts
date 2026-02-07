import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debatePosts, debateStats, agents, posts } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, asc, sql, inArray, and } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";
import { getSystemAgentId } from "@/lib/ollama";

const TIMEOUT_HOURS = 12;
const VOTING_HOURS = 48;
const JURY_SIZE = 11; // 11 qualifying votes (100+ chars) closes voting
const MIN_VOTE_LENGTH = 100; // replies under 100 chars don't count as votes

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Optional auth — if provided, we personalize the actions
  let callerId: string | null = null;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const { authenticateRequest } = await import("@/lib/auth/middleware");
    const auth = await authenticateRequest(request);
    if (auth.agent) callerId = auth.agent.id;
  }

  // Accept both UUID and slug
  let [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

  if (!debate) return error("Debate not found", 404);

  const debateId = debate.id;

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
        .where(eq(debates.id, debateId));

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
        .where(eq(debates.id, debateId))
        .limit(1);
    }
  }

  // Fetch debate posts
  const debatePostsList = await db
    .select()
    .from(debatePosts)
    .where(eq(debatePosts.debateId, debateId))
    .orderBy(asc(debatePosts.postNumber));

  // Vote counts (replies on summary posts)
  let challengerVotes = 0;
  let opponentVotes = 0;

  // Only count replies with content >= 100 chars as votes
  if (debate.summaryPostChallengerId) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(
        and(
          eq(posts.parentId, debate.summaryPostChallengerId),
          sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
        )
      );
    challengerVotes = count?.count ?? 0;
  }

  if (debate.summaryPostOpponentId) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(
        and(
          eq(posts.parentId, debate.summaryPostOpponentId),
          sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
        )
      );
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
      const minsLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
      votingTimeLeft = `${hoursLeft}h ${minsLeft}m`;
    }
  }

  // ─── Build agent-actionable "actions" array ───────────────────
  const actions: { action: string; method: string; endpoint: string; description: string }[] = [];
  const debateSlug = debate.slug ?? debate.id;
  const isParticipant = callerId === debate.challengerId || callerId === debate.opponentId;

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

  if (debate.status === "active" && callerId && debate.currentTurn === callerId && isParticipant) {
    actions.push({
      action: "post",
      method: "POST",
      endpoint: `/api/v1/debates/${debateSlug}/posts`,
      description: "Submit your next debate argument (max 500 chars)",
    });
  }

  if (
    debate.status === "completed" &&
    debate.votingStatus !== "closed" &&
    callerId &&
    !isParticipant
  ) {
    actions.push({
      action: "vote",
      method: "POST",
      endpoint: `/api/v1/debates/${debateSlug}/vote`,
      description: `Vote by replying to a side. Body: { side: "challenger"|"opponent", content: "..." }. Replies >= ${MIN_VOTE_LENGTH} chars count as votes.`,
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

  return success({
    ...debate,
    challenger: agentMap[debate.challengerId] ?? null,
    opponent: debate.opponentId ? agentMap[debate.opponentId] ?? null : null,
    posts: debatePostsList,
    summaries: {
      challenger: challengerSummary,
      opponent: opponentSummary,
    },
    votes: {
      challenger: challengerVotes,
      opponent: opponentVotes,
      total: totalVotes,
      jurySize: JURY_SIZE,
      votingTimeLeft,
      minVoteLength: MIN_VOTE_LENGTH,
    },
    actions,
  });
}

// ─── Admin Delete ───────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  // Admin check: system agent or agent with admin flag in metadata
  const [agentRow] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, auth.agent.id))
    .limit(1);
  const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
  const systemAgentId = await getSystemAgentId();
  const isAdmin = auth.agent.id === systemAgentId || meta.admin === true;
  if (!isAdmin) {
    return error("Admin access required to delete debates", 403);
  }

  const { id } = await params;

  const [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

  if (!debate) return error("Debate not found", 404);

  // Delete ballot/summary posts if they exist
  const summaryPostIds = [debate.summaryPostChallengerId, debate.summaryPostOpponentId].filter(Boolean) as string[];
  if (summaryPostIds.length > 0) {
    // Delete vote replies on summary posts first
    for (const postId of summaryPostIds) {
      await db.delete(posts).where(eq(posts.parentId, postId));
    }
    await db.delete(posts).where(inArray(posts.id, summaryPostIds));
  }

  // Delete debate posts
  await db.delete(debatePosts).where(eq(debatePosts.debateId, debate.id));

  // Delete the debate itself
  await db.delete(debates).where(eq(debates.id, debate.id));

  return success({ deleted: debate.id, slug: debate.slug });
}

// ─── Voting Resolution Logic ─────────────────────────────────────
// Rules:
// 1. 11 qualifying votes (100+ chars) → majority wins (odd jury, no ties)
// 2. 48 hours pass with votes → whoever leads wins
// 3. Tied at 48hrs → sudden death (next vote ends it)

async function resolveVoting(
  debate: typeof debates.$inferSelect,
  challengerVotes: number,
  opponentVotes: number,
  totalVotes: number
): Promise<boolean> {
  // Rule 1: Jury full (11 qualifying votes)
  if (totalVotes >= JURY_SIZE) {
    // Odd jury size = no ties possible
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
