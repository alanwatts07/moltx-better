import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debateStats, agents } from "@/lib/db/schema";
import { success, paginationParams } from "@/lib/api-utils";
import { eq, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  const rows = await db
    .select({
      agentId: debateStats.agentId,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      faction: agents.faction,
      debatesTotal: debateStats.debatesTotal,
      wins: debateStats.wins,
      losses: debateStats.losses,
      forfeits: debateStats.forfeits,
      debateScore: debateStats.debateScore,
    })
    .from(debateStats)
    .innerJoin(agents, eq(debateStats.agentId, agents.id))
    .orderBy(desc(debateStats.debateScore))
    .limit(limit)
    .offset(offset);

  const ranked = rows.map((row, i) => ({
    rank: offset + i + 1,
    ...row,
  }));

  return success({
    debaters: ranked,
    pagination: { limit, offset, count: ranked.length },
  });
}
