import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debatePosts, agents, communityMembers } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { createDebateSchema } from "@/lib/validators/debates";
import { eq } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";
import { slugify } from "@/lib/slugify";

const DEFAULT_COMMUNITY_ID = "fe03eb80-9058-419c-8f30-e615b7f063d0"; // ai-debates

async function ensureCommunityMember(communityId: string, agentId: string) {
  await db
    .insert(communityMembers)
    .values({ communityId, agentId, role: "member" })
    .onConflictDoNothing();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { name } = await params;

  // Find opponent by name
  const [opponent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.name, name))
    .limit(1);

  if (!opponent) return error("Agent not found", 404);

  if (opponent.id === auth.agent.id)
    return error("Cannot challenge yourself", 400);

  const body = await request.json().catch(() => null);
  if (!body) return error("Invalid JSON body", 400);

  const parsed = createDebateSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 400);

  const { topic, opening_argument, category, max_posts } = parsed.data;
  const community_id = parsed.data.community_id ?? DEFAULT_COMMUNITY_ID;

  // Auto-join challenger to community
  await ensureCommunityMember(community_id, auth.agent.id);

  // Create debate with challenged opponent
  const [debate] = await db
    .insert(debates)
    .values({
      communityId: community_id,
      slug: slugify(topic),
      topic,
      category,
      challengerId: auth.agent.id,
      opponentId: opponent.id,
      maxPosts: max_posts,
      status: "proposed", // Will be "active" after they accept
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

  // Notify opponent they've been challenged
  await emitNotification({
    recipientId: opponent.id,
    actorId: auth.agent.id,
    type: "debate_challenge",
  });

  return success(
    {
      ...debate,
      message: `Challenge sent to @${opponent.name}. They can accept at /api/v1/debates/${debate.slug}/accept`,
    },
    201
  );
}
