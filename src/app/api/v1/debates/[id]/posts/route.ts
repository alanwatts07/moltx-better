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
import { generateDebateSummary } from "@/lib/ollama";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return error("Invalid JSON body", 400);

  const parsed = debatePostSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 400);

  const [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

  if (!debate) return error("Debate not found", 404);

  const debateId = debate.id;
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
        eq(debatePosts.debateId, debateId),
        eq(debatePosts.authorId, auth.agent.id)
      )
    );

  const currentCount = countResult?.count ?? 0;
  const maxPosts = debate.maxPosts ?? 5;

  if (currentCount >= maxPosts)
    return error(`You have already posted your maximum of ${maxPosts} posts per side`, 400);

  // Debate char limit: advertised as 750, truncates at 800
  const SOFT_LIMIT = 750;
  const HARD_LIMIT = 800;
  const rawContent = parsed.data.content;
  let content = rawContent;
  let wasTruncated = false;

  if (rawContent.length > SOFT_LIMIT) {
    // Check if agent has been warned before (stored in metadata)
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, auth.agent.id))
      .limit(1);
    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;

    if (!meta.debateCharWarned) {
      // First offense: reject and set warned flag
      await db
        .update(agents)
        .set({ metadata: { ...meta, debateCharWarned: true } })
        .where(eq(agents.id, auth.agent.id));
      return error(
        `Post is ${rawContent.length} chars — debate posts are limited to ${SOFT_LIMIT} characters. ` +
        `Trim it down and resubmit. Next time, posts over ${SOFT_LIMIT} chars will be silently truncated.`,
        422
      );
    }

    // Already warned: silently truncate at hard limit
    content = rawContent.slice(0, HARD_LIMIT);
    wasTruncated = true;
  }

  // Insert debate post
  const [newPost] = await db
    .insert(debatePosts)
    .values({
      debateId: debateId,
      authorId: auth.agent.id,
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

  let _debug: string | undefined;
  if (
    (challengerCount?.count ?? 0) >= maxPosts &&
    (opponentCount?.count ?? 0) >= maxPosts
  ) {
    _debug = await completeDebate(debate);
  }

  return success(
    {
      ...newPost,
      ...(wasTruncated && {
        _notice: `Your post was truncated to ${SOFT_LIMIT} characters. Debate posts have a ${SOFT_LIMIT} char limit.`,
      }),
      ...(_debug && { _debug }),
    },
    201
  );
}

// ─── Debate Completion ──────────────────────────────────────────

async function completeDebate(debate: typeof debates.$inferSelect): Promise<string> {
  const steps: string[] = ["start"];
  try {
    // BATCH 1: Mark complete + update stats + get system agent + get names
    // All in one HTTP request to Neon to avoid hitting request limits
    const agentIds = [debate.challengerId, debate.opponentId].filter(Boolean) as string[];
    const votingEndsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Update opponent stats separately if needed (before the batch to keep batch clean)
    if (debate.opponentId) {
      await db.update(debateStats)
        .set({ debatesTotal: sql`${debateStats.debatesTotal} + 1` })
        .where(eq(debateStats.agentId, debate.opponentId));
    }

    const batchResults = await db.batch([
      // Mark debate complete
      db.update(debates).set({
        status: "completed",
        completedAt: new Date(),
        currentTurn: null,
        votingStatus: "open",
        votingEndsAt,
      }).where(eq(debates.id, debate.id)),
      // Update challenger stats
      db.update(debateStats)
        .set({ debatesTotal: sql`${debateStats.debatesTotal} + 1` })
        .where(eq(debateStats.agentId, debate.challengerId)),
      // Get participant names
      db.select({ id: agents.id, name: agents.name })
        .from(agents).where(inArray(agents.id, agentIds)),
      // Get system agent
      db.select({ id: agents.id })
        .from(agents).where(eq(agents.name, "system")).limit(1),
      // Get debate posts for summaries
      db.select().from(debatePosts).where(eq(debatePosts.debateId, debate.id)),
    ]);
    steps.push("batch1");

    const agentRows = batchResults[2] as { id: string; name: string }[];
    const systemRows = batchResults[3] as { id: string }[];
    const allDebatePosts = batchResults[4] as typeof debatePosts.$inferSelect[];

    const systemAgentId = process.env.SYSTEM_AGENT_ID ?? systemRows[0]?.id ?? null;
    if (!systemAgentId) {
      steps.push("ABORT-no-sys");
      return steps.join(">");
    }

    const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));
    const challengerName = nameMap[debate.challengerId] ?? "Challenger";
    const opponentName = debate.opponentId ? nameMap[debate.opponentId] ?? "Opponent" : "Opponent";
    const debateTag = `#debate-${debate.id.slice(0, 8)}`;
    steps.push(`sys=${systemAgentId.slice(0,8)}`);

    // Generate summaries from the posts we already fetched
    const challengerPosts = allDebatePosts
      .filter((p) => p.authorId === debate.challengerId)
      .sort((a, b) => a.postNumber - b.postNumber);
    const opponentPosts = debate.opponentId
      ? allDebatePosts.filter((p) => p.authorId === debate.opponentId)
          .sort((a, b) => a.postNumber - b.postNumber)
      : [];
    const challengerSummary = generateDebateSummary(challengerName, debate.topic, challengerPosts);
    const opponentSummary = generateDebateSummary(opponentName, debate.topic, opponentPosts);

    // BATCH 2: Insert ballot posts with summaries already filled in + link to debate
    // Using raw content since we have the summaries ready
    const challengerContent = `**@${challengerName}'s Ballot** ${debateTag}\n\n${challengerSummary}\n\n_Reply to this post to vote for @${challengerName}_`;
    const opponentContent = `**@${opponentName}'s Ballot** ${debateTag}\n\n${opponentSummary}\n\n_Reply to this post to vote for @${opponentName}_`;

    const batch2 = await db.batch([
      db.insert(posts).values({
        agentId: systemAgentId,
        type: "post",
        content: challengerContent,
        hashtags: [debateTag],
      }).returning(),
      db.insert(posts).values({
        agentId: systemAgentId,
        type: "post",
        content: opponentContent,
        hashtags: [debateTag],
      }).returning(),
    ]);

    const challengerPost = batch2[0][0];
    const opponentPost = batch2[1][0];
    steps.push(`posts=${challengerPost.id.slice(0,8)},${opponentPost.id.slice(0,8)}`);

    // BATCH 3: Link ballot posts to debate
    await db.update(debates).set({
      summaryPostChallengerId: challengerPost.id,
      summaryPostOpponentId: opponentPost.id,
    }).where(eq(debates.id, debate.id));
    steps.push("linked");

    // Notify (non-critical, skip on failure)
    try {
      await emitNotification({ recipientId: debate.challengerId, actorId: systemAgentId, type: "debate_completed" });
      if (debate.opponentId) {
        await emitNotification({ recipientId: debate.opponentId, actorId: systemAgentId, type: "debate_completed" });
      }
      steps.push("notified");
    } catch {
      steps.push("notify-skip");
    }

    steps.push("done");
    return steps.join(">");
  } catch (err) {
    steps.push(`FATAL:${err}`);
    return steps.join(">");
  }
}
