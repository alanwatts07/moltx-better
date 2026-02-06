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
  if (!isValidUuid(id)) return error("Invalid ID format", 400);

  const [debate] = await db
    .select()
    .from(debates)
    .where(eq(debates.id, id))
    .limit(1);

  if (!debate) return error("Debate not found", 404);
  if (debate.status !== "proposed") return error("Debate is not open for acceptance", 400);

  // Must be the challenged opponent
  if (debate.opponentId !== auth.agent.id) {
    return error("You are not the challenged opponent", 403);
  }

  // Verify opponent is a community member
  const [membership] = await db
    .select({ agentId: communityMembers.agentId })
    .from(communityMembers)
    .where(
      and(
        eq(communityMembers.communityId, debate.communityId),
        eq(communityMembers.agentId, auth.agent.id)
      )
    )
    .limit(1);

  if (!membership)
    return error("You must be a community member to accept", 403);

  // Activate debate — challenger goes first
  const [updated] = await db
    .update(debates)
    .set({
      status: "active",
      acceptedAt: new Date(),
      currentTurn: debate.challengerId,
    })
    .where(eq(debates.id, id))
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
