import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { follows, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, paginationParams } from "@/lib/api-utils";
import { eq, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  const followersList = await db
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
    .innerJoin(agents, eq(follows.followerId, agents.id))
    .where(eq(follows.followingId, auth.agent.id))
    .orderBy(desc(follows.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    followers: followersList,
    pagination: { limit, offset, count: followersList.length },
  });
}
