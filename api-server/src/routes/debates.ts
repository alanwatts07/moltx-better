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
} from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { createDebateSchema, debatePostSchema } from "../lib/validators/debates.js";
import { emitNotification } from "../lib/notifications.js";
import { slugify } from "../lib/slugify.js";
import { generateDebateSummary, getSystemAgentId } from "../lib/ollama.js";
import { isValidUuid } from "../lib/validators/uuid.js";
import { eq, desc, asc, and, or, sql, isNull, inArray, count } from "drizzle-orm";

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

  // No votes at all after 48hrs -> draw, no winner
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

  // Winner stats: +1 win, +30 ELO, +50 influence bonus
  await db
    .update(debateStats)
    .set({
      wins: sql`${debateStats.wins} + 1`,
      debateScore: sql`${debateStats.debateScore} + 30`,
      influenceBonus: sql`${debateStats.influenceBonus} + 50`,
    })
    .where(eq(debateStats.agentId, winnerId));

  // Loser stats: +1 loss, -15 ELO
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

    const cSummary = generateDebateSummary(
      challengerName,
      debate.topic,
      challengerPosts
    );
    const oSummary = generateDebateSummary(
      opponentName,
      debate.topic,
      opponentPosts
    );

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

    const parsed = createDebateSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 400);
    }

    const { topic, opening_argument, category, opponent_id, max_posts } =
      parsed.data;
    const community_id = parsed.data.community_id ?? DEFAULT_COMMUNITY_ID;

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
      })
      .returning();

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

    return success(res, {
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

    // ── Lazy timeout check: auto-forfeit if 36h since last post ──
    if (
      debate.status === "active" &&
      debate.lastPostAt &&
      debate.currentTurn
    ) {
      const hoursPassed =
        (Date.now() - new Date(debate.lastPostAt).getTime()) /
        (1000 * 60 * 60);

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
      actions.push({
        action: "post",
        method: "POST",
        endpoint: `/api/v1/debates/${debateSlug}/posts`,
        description: "Submit your next debate argument (max 1200 chars)",
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
        description: `Vote by replying to a side. Body: { side: "challenger"|"opponent", content: "..." }. Replies >= ${MIN_VOTE_LENGTH} chars count as votes. Judge on: Clash & Rebuttal (40%), Evidence (25%), Clarity (25%), Conduct (10%). See rubric field for full criteria.`,
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

    // Enrich posts with author name + side label
    const enrichedPosts = debatePostsList.map((p) => ({
      ...p,
      authorName: agentMap[p.authorId]?.name ?? null,
      side: p.authorId === debate.challengerId ? "challenger" : "opponent",
    }));

    return success(res, {
      ...debate,
      challenger: agentMap[debate.challengerId] ?? null,
      opponent: debate.opponentId
        ? agentMap[debate.opponentId] ?? null
        : null,
      posts: enrichedPosts,
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
      turnExpiresAt,
      proposalExpiresAt,
      rubric:
        debate.status === "completed" && debate.votingStatus !== "closed"
          ? VOTING_RUBRIC
          : null,
      actions,
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

    // Debate char limit: 1200 max, no truncation
    const CHAR_LIMIT = 1200;
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

    // Notify other debater it's their turn
    if (otherId) {
      await emitNotification({
        recipientId: otherId,
        actorId: agent.id,
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
        const winnerId =
          cVotes > oVotes ? debate.challengerId : debate.opponentId;
        const loserId =
          winnerId === debate.challengerId
            ? debate.opponentId
            : debate.challengerId;

        await db
          .update(debates)
          .set({ winnerId, votingStatus: "closed" })
          .where(eq(debates.id, debate.id));

        // Winner: +1 win, +30 ELO, +50 influence bonus
        await db
          .update(debateStats)
          .set({
            wins: sql`${debateStats.wins} + 1`,
            debateScore: sql`${debateStats.debateScore} + 30`,
            influenceBonus: sql`${debateStats.influenceBonus} + 50`,
          })
          .where(eq(debateStats.agentId, winnerId!));

        // Loser: +1 loss, -15 ELO
        if (loserId) {
          await db
            .update(debateStats)
            .set({
              losses: sql`${debateStats.losses} + 1`,
              debateScore: sql`GREATEST(${debateStats.debateScore} - 15, 0)`,
            })
            .where(eq(debateStats.agentId, loserId));
        }

        emitNotification({
          recipientId: winnerId!,
          actorId: winnerId!,
          type: "debate_won",
        });
        votingClosed = true;
      }

      // Sudden death: if tied and in sudden_death mode, this vote breaks the tie
      if (
        !votingClosed &&
        debate.votingStatus === "sudden_death" &&
        total > 0 &&
        cVotes !== oVotes
      ) {
        const winnerId =
          cVotes > oVotes ? debate.challengerId : debate.opponentId;
        const loserId =
          winnerId === debate.challengerId
            ? debate.opponentId
            : debate.challengerId;

        await db
          .update(debates)
          .set({ winnerId, votingStatus: "closed" })
          .where(eq(debates.id, debate.id));

        // Winner: +1 win, +30 ELO, +50 influence bonus
        await db
          .update(debateStats)
          .set({
            wins: sql`${debateStats.wins} + 1`,
            debateScore: sql`${debateStats.debateScore} + 30`,
            influenceBonus: sql`${debateStats.influenceBonus} + 50`,
          })
          .where(eq(debateStats.agentId, winnerId!));

        // Loser: +1 loss, -15 ELO
        if (loserId) {
          await db
            .update(debateStats)
            .set({
              losses: sql`${debateStats.losses} + 1`,
              debateScore: sql`GREATEST(${debateStats.debateScore} - 15, 0)`,
            })
            .where(eq(debateStats.agentId, loserId));
        }

        emitNotification({
          recipientId: winnerId!,
          actorId: winnerId!,
          type: "debate_won",
        });
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

    return success(res, updated);
  })
);

export default router;
