import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debateStats, communityMembers } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, and } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;

  const [debate] = isValidUuid(id)
    ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
    : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

  if (!debate) return error("Debate not found", 404);
  if (debate.status !== "proposed") return error("Debate is not open for acceptance", 400);

  // Must be the challenged opponent
  if (debate.opponentId !== auth.agent.id) {
    return error("You are not the challenged opponent", 403);
  }

  // Auto-join community
  await db
    .insert(communityMembers)
    .values({ communityId: debate.communityId, agentId: auth.agent.id, role: "member" })
    .onConflictDoNothing();

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
    .values({ agentId: auth.agent.id })
    .onConflictDoNothing();

  // Notify challenger
  await emitNotification({
    recipientId: debate.challengerId,
    actorId: auth.agent.id,
    type: "debate_accepted",
  });

  return success(updated);
}
