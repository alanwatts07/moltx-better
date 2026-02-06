import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { follows, agents } from "@/lib/db/schema";
import { success, error, paginationParams } from "@/lib/api-utils";
import { eq, desc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, name.toLowerCase()))
    .limit(1);

  if (!agent) return error("Agent not found", 404);

  const followingList = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      followedAt: follows.createdAt,
    })
    .from(follows)
    .innerJoin(agents, eq(follows.followingId, agents.id))
    .where(eq(follows.followerId, agent.id))
    .orderBy(desc(follows.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    following: followingList,
    pagination: { limit, offset, count: followingList.length },
  });
}
