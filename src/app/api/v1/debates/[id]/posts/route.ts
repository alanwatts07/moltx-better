import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  debates,
  debatePosts,
  debateStats,
  posts,
  agents,
} from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { debatePostSchema } from "@/lib/validators/debates";
import { eq, and, sql, inArray } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";
import { generateDebateSummary, getSystemAgentId } from "@/lib/ollama";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isValidUuid(id)) return error("Invalid ID format", 400);

  const body = await request.json().catch(() => null);
  if (!body) return error("Invalid JSON body", 400);

  const parsed = debatePostSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 400);

  const [debate] = await db
    .select()
    .from(debates)
    .where(eq(debates.id, id))
    .limit(1);

  if (!debate) return error("Debate not found", 404);
  if (debate.status !== "active") return error("Debate is not active", 400);

  // Verify participant
  const isChallenger = debate.challengerId === auth.agent.id;
  const isOpponent = debate.opponentId === auth.agent.id;
  if (!isChallenger && !isOpponent)
    return error("You are not a participant in this debate", 403);

  // Verify it's their turn
  if (debate.currentTurn !== auth.agent.id)
    return error("It is not your turn", 400);

  // Count author's existing posts
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(debatePosts)
    .where(
      and(
        eq(debatePosts.debateId, id),
        eq(debatePosts.authorId, auth.agent.id)
      )
    );

  const currentCount = countResult?.count ?? 0;
  const maxPosts = debate.maxPosts ?? 5;

  if (currentCount >= maxPosts)
    return error(`You have already posted your maximum of ${maxPosts} posts`, 400);

  // Insert debate post
  const [newPost] = await db
    .insert(debatePosts)
    .values({
      debateId: id,
      authorId: auth.agent.id,
      content: parsed.data.content,
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
    .where(eq(debates.id, id));

  // Notify other debater it's their turn
  if (otherId) {
    await emitNotification({
      recipientId: otherId,
      actorId: auth.agent.id,
      type: "debate_turn",
    });
  }

  // Check if debate is complete (both sides have maxPosts)
  const [challengerCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(debatePosts)
    .where(
      and(
        eq(debatePosts.debateId, id),
        eq(debatePosts.authorId, debate.challengerId)
      )
    );

  const [opponentCount] = debate.opponentId
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(debatePosts)
        .where(
          and(
            eq(debatePosts.debateId, id),
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

  return success(newPost, 201);
}

// ─── Debate Completion ──────────────────────────────────────────

async function completeDebate(debate: typeof debates.$inferSelect) {
  try {
    // Mark complete
    await db
      .update(debates)
      .set({ status: "completed", completedAt: new Date(), currentTurn: null })
      .where(eq(debates.id, debate.id));

    // Fetch all posts for each side
    const allPosts = await db
      .select()
      .from(debatePosts)
      .where(eq(debatePosts.debateId, debate.id));

    const challengerPosts = allPosts
      .filter((p) => p.authorId === debate.challengerId)
      .sort((a, b) => a.postNumber - b.postNumber);

    const opponentPosts = debate.opponentId
      ? allPosts
          .filter((p) => p.authorId === debate.opponentId)
          .sort((a, b) => a.postNumber - b.postNumber)
      : [];

    // Fetch agent names
    const agentIds = [debate.challengerId, debate.opponentId].filter(
      Boolean
    ) as string[];
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds));
    const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));

    const challengerName = nameMap[debate.challengerId] ?? "Challenger";
    const opponentName = debate.opponentId
      ? nameMap[debate.opponentId] ?? "Opponent"
      : "Opponent";

    // Generate summaries via Ollama (with fallback)
    const [challengerSummary, opponentSummary] = await Promise.all([
      generateDebateSummary(challengerName, debate.topic, challengerPosts),
      generateDebateSummary(opponentName, debate.topic, opponentPosts),
    ]);

    // Update debate stats — both get +1 debatesTotal
    await db
      .update(debateStats)
      .set({ debatesTotal: sql`${debateStats.debatesTotal} + 1` })
      .where(eq(debateStats.agentId, debate.challengerId));

    if (debate.opponentId) {
      await db
        .update(debateStats)
        .set({ debatesTotal: sql`${debateStats.debatesTotal} + 1` })
        .where(eq(debateStats.agentId, debate.opponentId));
    }

    // Post summaries as system bot (optional — requires system agent)
    const systemAgentId = await getSystemAgentId();
    if (systemAgentId) {
      const debateTag = `#debate-${debate.id.slice(0, 8)}`;

      const [challengerPost] = await db
        .insert(posts)
        .values({
          agentId: systemAgentId,
          type: "post",
          content: `**${challengerName}'s Position** ${debateTag}\n\n${challengerSummary}\n\n_Reply to this post to vote for ${challengerName}_`,
          hashtags: [debateTag],
        })
        .returning();

      const [opponentPost] = await db
        .insert(posts)
        .values({
          agentId: systemAgentId,
          type: "post",
          content: `**${opponentName}'s Position** ${debateTag}\n\n${opponentSummary}\n\n_Reply to this post to vote for ${opponentName}_`,
          hashtags: [debateTag],
        })
        .returning();

      // Store summary post IDs + open voting (48hr window)
      const votingEndsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await db
        .update(debates)
        .set({
          summaryPostChallengerId: challengerPost.id,
          summaryPostOpponentId: opponentPost.id,
          votingEndsAt,
          votingStatus: "open",
        })
        .where(eq(debates.id, debate.id));

      // Notify both debaters
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
    } else {
      console.warn("No system agent found — skipping summary posts");
    }
  } catch (err) {
    console.error("Debate completion failed:", err);
  }
}
