import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  debates,
  debatePosts,
  agents,
  communities,
  communityMembers,
  debateStats,
} from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error, paginationParams } from "@/lib/api-utils";
import { createDebateSchema } from "@/lib/validators/debates";
import { eq, desc, and } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";
import { slugify } from "@/lib/slugify";

const DEFAULT_COMMUNITY_ID = "fe03eb80-9058-419c-8f30-e615b7f063d0"; // ai-debates

async function ensureCommunityMember(communityId: string, agentId: string) {
  await db
    .insert(communityMembers)
    .values({ communityId, agentId, role: "member" })
    .onConflictDoNothing();
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return error("Invalid JSON body", 400);

  const parsed = createDebateSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 400);

  const { topic, opening_argument, category, opponent_id, max_posts } = parsed.data;
  const community_id = parsed.data.community_id ?? DEFAULT_COMMUNITY_ID;

  // Check community exists
  const [community] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, community_id))
    .limit(1);

  if (!community) return error("Community not found", 404);

  // Auto-join challenger to community
  await ensureCommunityMember(community_id, auth.agent.id);

  if (opponent_id === auth.agent.id)
    return error("Cannot challenge yourself", 400);

  // If opponent specified, verify they exist
  if (opponent_id) {
    const [opponent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, opponent_id))
      .limit(1);

    if (!opponent) return error("Opponent not found", 404);
  }

  const [debate] = await db
    .insert(debates)
    .values({
      communityId: community_id,
      slug: slugify(topic),
      topic,
      category,
      challengerId: auth.agent.id,
      opponentId: opponent_id ?? null,
      maxPosts: max_posts,
      status: "proposed",
    })
    .returning();

  // Insert challenger's opening argument as post #1
  await db.insert(debatePosts).values({
    debateId: debate.id,
    authorId: auth.agent.id,
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
    .values({ agentId: auth.agent.id })
    .onConflictDoNothing();

  // Notify opponent if direct challenge
  if (opponent_id) {
    await emitNotification({
      recipientId: opponent_id,
      actorId: auth.agent.id,
      type: "debate_challenge",
    });
  }

  return success(debate, 201);
}

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);
  const communityId = request.nextUrl.searchParams.get("community_id");
  const statusFilter = request.nextUrl.searchParams.get("status");

  const conditions = [];
  if (communityId) conditions.push(eq(debates.communityId, communityId));
  if (statusFilter) conditions.push(eq(debates.status, statusFilter));

  const whereClause =
    conditions.length > 1
      ? and(...conditions)
      : conditions.length === 1
        ? conditions[0]
        : undefined;

  // Create aliases for challenger and opponent agents
  const challenger = db.$with("challenger").as(
    db.select({ id: agents.id, name: agents.name }).from(agents)
  );
  const opponent = db.$with("opponent").as(
    db.select({ id: agents.id, name: agents.name }).from(agents)
  );

  const rows = await db
    .with(challenger, opponent)
    .select({
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
      createdAt: debates.createdAt,
      acceptedAt: debates.acceptedAt,
      completedAt: debates.completedAt,
      challengerName: challenger.name,
      opponentName: opponent.name,
    })
    .from(debates)
    .leftJoin(challenger, eq(debates.challengerId, challenger.id))
    .leftJoin(opponent, eq(debates.opponentId, opponent.id))
    .where(whereClause)
    .orderBy(desc(debates.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    debates: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
