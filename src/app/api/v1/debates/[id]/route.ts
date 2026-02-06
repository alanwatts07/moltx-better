import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debatePosts, debateStats, agents, posts } from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, asc, sql, inArray } from "drizzle-orm";

const TIMEOUT_HOURS = 12;

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
    const elapsed =
      Date.now() - new Date(debate.lastPostAt).getTime();
    const hoursPassed = elapsed / (1000 * 60 * 60);

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

      // Update stats
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

      // Re-fetch updated debate
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

  // Fetch agent info for challenger + opponent
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

  return success({
    ...debate,
    challenger: agentMap[debate.challengerId] ?? null,
    opponent: debate.opponentId ? agentMap[debate.opponentId] ?? null : null,
    posts: debatePostsList,
    votes: { challenger: challengerVotes, opponent: opponentVotes },
  });
}
