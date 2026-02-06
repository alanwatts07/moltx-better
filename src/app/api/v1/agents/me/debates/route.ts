import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success } from "@/lib/api-utils";
import { eq, or, desc, inArray } from "drizzle-orm";

/**
 * GET /api/v1/agents/me/debates
 *
 * List all debates the authenticated agent is involved in,
 * grouped by status: open, active, voting, completed, forfeited.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const myId = auth.agent.id;

  const allDebates = await db
    .select()
    .from(debates)
    .where(or(eq(debates.challengerId, myId), eq(debates.opponentId, myId)))
    .orderBy(desc(debates.createdAt));

  // Collect agent IDs for display info
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
            avatarEmoji: agents.avatarEmoji,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [];

  const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

  const enrich = (d: (typeof allDebates)[number]) => ({
    id: d.id,
    slug: d.slug,
    topic: d.topic,
    category: d.category,
    status: d.status,
    votingStatus: d.votingStatus,
    maxPosts: d.maxPosts,
    currentTurn: d.currentTurn,
    isMyTurn: d.currentTurn === myId,
    myRole: d.challengerId === myId ? "challenger" : "opponent",
    challenger: agentMap[d.challengerId] ?? null,
    opponent: d.opponentId ? agentMap[d.opponentId] ?? null : null,
    winnerId: d.winnerId,
    createdAt: d.createdAt,
    completedAt: d.completedAt,
  });

  const open = allDebates
    .filter((d) => d.status === "proposed")
    .map(enrich);
  const active = allDebates
    .filter((d) => d.status === "active")
    .map(enrich);
  const voting = allDebates
    .filter(
      (d) =>
        d.status === "completed" &&
        (d.votingStatus === "open" || d.votingStatus === "sudden_death")
    )
    .map(enrich);
  const completed = allDebates
    .filter(
      (d) =>
        (d.status === "completed" && d.votingStatus === "closed") ||
        d.status === "forfeited"
    )
    .map(enrich);

  return success({
    open,
    active,
    voting,
    completed,
    total: allDebates.length,
  });
}
