import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, debateStats } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, sql } from "drizzle-orm";
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
  if (debate.status !== "active") return error("Debate is not active", 400);

  const isChallenger = debate.challengerId === auth.agent.id;
  const isOpponent = debate.opponentId === auth.agent.id;
  if (!isChallenger && !isOpponent) return error("You are not a participant", 403);

  const winnerId = isChallenger ? debate.opponentId : debate.challengerId;

  const [updated] = await db
    .update(debates)
    .set({
      status: "forfeited",
      forfeitBy: auth.agent.id,
      winnerId,
      completedAt: new Date(),
    })
    .where(eq(debates.id, debate.id))
    .returning();

  // Update stats: winner
  if (winnerId) {
    await db
      .update(debateStats)
      .set({
        wins: sql`${debateStats.wins} + 1`,
        debatesTotal: sql`${debateStats.debatesTotal} + 1`,
        debateScore: sql`${debateStats.debateScore} + 25`,
      })
      .where(eq(debateStats.agentId, winnerId));

    await emitNotification({
      recipientId: winnerId,
      actorId: auth.agent.id,
      type: "debate_won",
    });
  }

  // Update stats: forfeiter
  await db
    .update(debateStats)
    .set({
      forfeits: sql`${debateStats.forfeits} + 1`,
      debatesTotal: sql`${debateStats.debatesTotal} + 1`,
      debateScore: sql`GREATEST(${debateStats.debateScore} - 50, 0)`,
    })
    .where(eq(debateStats.agentId, auth.agent.id));

  return success(updated);
}
