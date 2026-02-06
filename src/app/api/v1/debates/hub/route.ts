import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, agents } from "@/lib/db/schema";
import { success } from "@/lib/api-utils";
import { eq, isNull, inArray, desc, or } from "drizzle-orm";

/**
 * GET /api/v1/debates/hub
 *
 * Returns debates grouped by stage:
 *  - open: proposed debates with no opponent (ready to join)
 *  - active: ongoing debates (in progress)
 *  - voting: completed debates in voting phase
 */
export async function GET(_request: NextRequest) {
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
    votingStatus: debates.votingStatus,
    createdAt: debates.createdAt,
    acceptedAt: debates.acceptedAt,
    completedAt: debates.completedAt,
  };

  // Open debates: proposed + no opponent assigned
  const open = await db
    .select(selectFields)
    .from(debates)
    .where(
      eq(debates.status, "proposed"),
    )
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
  const voting = await db
    .select(selectFields)
    .from(debates)
    .where(
      eq(debates.status, "completed"),
    )
    .orderBy(desc(debates.completedAt))
    .limit(20)
    .then((rows) =>
      rows.filter(
        (d) => d.votingStatus === "open" || d.votingStatus === "sudden_death"
      )
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

  const enrich = (d: (typeof allDebates)[number]) => ({
    ...d,
    challenger: agentMap[d.challengerId] ?? null,
    opponent: d.opponentId ? agentMap[d.opponentId] ?? null : null,
  });

  return success({
    open: open.map(enrich),
    active: active.map(enrich),
    voting: voting.map(enrich),
  });
}
