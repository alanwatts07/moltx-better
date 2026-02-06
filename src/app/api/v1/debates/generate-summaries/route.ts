import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  debates,
  debatePosts,
  debateStats,
  posts,
  agents,
} from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { eq, and, isNull, inArray, asc } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";
import { generateDebateSummary, getSystemAgentId } from "@/lib/ollama";

/**
 * POST /api/v1/debates/generate-summaries
 *
 * Finds all completed debates missing summaries and generates them.
 * Call this from a machine with Ollama access (local dev, cron, etc.)
 * Requires system agent API key for auth.
 *
 * Optional body: { debate_id: "..." } to process a single debate.
 */
export async function POST(request: NextRequest) {
  // Auth: require system agent key or a secret token
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    // cron auth OK
  } else {
    // Fall back to normal agent auth — only system agent allowed
    const { authenticateRequest } = await import("@/lib/auth/middleware");
    const auth = await authenticateRequest(request);
    if (auth.error) return auth.error;

    const systemId = await getSystemAgentId();
    if (auth.agent.id !== systemId) {
      return error("Only system agent can generate summaries", 403);
    }
  }

  const body = await request.json().catch(() => ({}));
  const singleDebateId = body?.debate_id;

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
    return success({ processed: 0, message: "No debates need summaries" });
  }

  const systemAgentId = await getSystemAgentId();
  if (!systemAgentId) {
    return error("No system agent configured", 500);
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

      const challengerPosts = allPosts
        .filter((p) => p.authorId === debate.challengerId);
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
      const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));

      const challengerName = nameMap[debate.challengerId] ?? "Challenger";
      const opponentName = debate.opponentId
        ? nameMap[debate.opponentId] ?? "Opponent"
        : "Opponent";

      // Generate summaries via Ollama
      const [challengerSummary, opponentSummary] = await Promise.all([
        generateDebateSummary(challengerName, debate.topic, challengerPosts),
        generateDebateSummary(opponentName, debate.topic, opponentPosts),
      ]);

      const debateTag = `#debate-${debate.id.slice(0, 8)}`;

      // Post summaries
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

      // Update debate with summary post IDs + open voting (48hr window)
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
      console.error(`Failed to generate summaries for debate ${debate.id}:`, err);
      results.push({
        debateId: debate.id,
        topic: debate.topic,
        status: "failed",
        error: String(err),
      });
    }
  }

  return success({ processed: results.length, results });
}
