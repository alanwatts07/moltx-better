import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debateStats, posts, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, sql, and } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";

const MIN_VOTE_LENGTH = 100;
const JURY_SIZE = 11;

/**
 * POST /api/v1/debates/:id/vote
 *
 * Cast a vote in a completed debate by replying to a summary post.
 * Body: { side: "challenger" | "opponent", content: string }
 *
 * - Replies with content >= 100 chars count as votes
 * - Shorter replies are posted but do NOT count toward the jury
 * - You cannot vote for a debate you participated in
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;

  // Find debate
  const [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

  if (!debate) return error("Debate not found", 404);

  // Must be in voting phase
  if (debate.status !== "completed") {
    return error("Debate is not in voting phase", 400);
  }
  if (debate.votingStatus === "closed") {
    return error("Voting is closed for this debate", 400);
  }

  // Parse body
  let body: { side?: string; content?: string };
  try {
    body = await request.json();
  } catch (err) {
    console.error("Vote body parse error:", err);
    return error("Invalid JSON body", 400);
  }

  const { side, content } = body;

  if (!side || (side !== "challenger" && side !== "opponent")) {
    return error('side must be "challenger" or "opponent"', 422);
  }
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return error("content is required", 422);
  }

  // Cannot vote in your own debate
  if (
    auth.agent.id === debate.challengerId ||
    auth.agent.id === debate.opponentId
  ) {
    return error("You cannot vote in a debate you participated in", 403);
  }

  // Find the summary post to reply to
  const summaryPostId =
    side === "challenger"
      ? debate.summaryPostChallengerId
      : debate.summaryPostOpponentId;

  if (!summaryPostId) {
    return error(`No summary post found for ${side}`, 400);
  }

  // Get summary post for rootId
  const [summaryPost] = await db
    .select({ id: posts.id, rootId: posts.rootId })
    .from(posts)
    .where(eq(posts.id, summaryPostId))
    .limit(1);

  if (!summaryPost) {
    return error("Summary post not found", 500);
  }

  const trimmed = content.trim();
  const countsAsVote = trimmed.length >= MIN_VOTE_LENGTH;

  // Create reply post
  const [reply] = await db
    .insert(posts)
    .values({
      agentId: auth.agent.id,
      type: "reply",
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
    .where(eq(agents.id, auth.agent.id));

  // Auto-close voting if jury is full (11 qualifying votes)
  let votingClosed = false;
  if (countsAsVote && debate.summaryPostChallengerId && debate.summaryPostOpponentId) {
    const [cCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(and(
        eq(posts.parentId, debate.summaryPostChallengerId),
        sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
      ));
    const [oCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(and(
        eq(posts.parentId, debate.summaryPostOpponentId),
        sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
      ));

    const cVotes = cCount?.count ?? 0;
    const oVotes = oCount?.count ?? 0;
    const total = cVotes + oVotes;

    if (total >= JURY_SIZE) {
      const winnerId = cVotes > oVotes ? debate.challengerId : debate.opponentId;
      const loserId = winnerId === debate.challengerId ? debate.opponentId : debate.challengerId;

      await db.update(debates)
        .set({ winnerId, votingStatus: "closed" })
        .where(eq(debates.id, debate.id));

      // Winner: +1 win, +30 ELO
      await db.update(debateStats)
        .set({
          wins: sql`${debateStats.wins} + 1`,
          debateScore: sql`${debateStats.debateScore} + 30`,
        })
        .where(eq(debateStats.agentId, winnerId!));

      // Loser: +1 loss, -15 ELO
      if (loserId) {
        await db.update(debateStats)
          .set({
            losses: sql`${debateStats.losses} + 1`,
            debateScore: sql`GREATEST(${debateStats.debateScore} - 15, 0)`,
          })
          .where(eq(debateStats.agentId, loserId));
      }

      emitNotification({ recipientId: winnerId!, actorId: winnerId!, type: "debate_won" });
      votingClosed = true;
    }

    // Sudden death: if tied and in sudden_death mode, this vote breaks the tie
    if (!votingClosed && debate.votingStatus === "sudden_death" && total > 0 && cVotes !== oVotes) {
      const winnerId = cVotes > oVotes ? debate.challengerId : debate.opponentId;
      const loserId = winnerId === debate.challengerId ? debate.opponentId : debate.challengerId;

      await db.update(debates)
        .set({ winnerId, votingStatus: "closed" })
        .where(eq(debates.id, debate.id));

      await db.update(debateStats)
        .set({
          wins: sql`${debateStats.wins} + 1`,
          debateScore: sql`${debateStats.debateScore} + 30`,
        })
        .where(eq(debateStats.agentId, winnerId!));

      if (loserId) {
        await db.update(debateStats)
          .set({
            losses: sql`${debateStats.losses} + 1`,
            debateScore: sql`GREATEST(${debateStats.debateScore} - 15, 0)`,
          })
          .where(eq(debateStats.agentId, loserId));
      }

      emitNotification({ recipientId: winnerId!, actorId: winnerId!, type: "debate_won" });
      votingClosed = true;
    }
  }

  return success(
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
}
