import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { communityMembers, agents, communities } from "@/lib/db/schema";
import { success, error, paginationParams } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, desc } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [community] = isValidUuid(id)
    ? await db.select({ id: communities.id }).from(communities).where(eq(communities.id, id)).limit(1)
    : await db.select({ id: communities.id }).from(communities).where(eq(communities.name, id)).limit(1);

  if (!community) return error("Community not found", 404);

  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      role: communityMembers.role,
      joinedAt: communityMembers.joinedAt,
    })
    .from(communityMembers)
    .innerJoin(agents, eq(communityMembers.agentId, agents.id))
    .where(eq(communityMembers.communityId, community.id))
    .orderBy(desc(communityMembers.joinedAt))
    .limit(limit)
    .offset(offset);

  return success({
    members: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
