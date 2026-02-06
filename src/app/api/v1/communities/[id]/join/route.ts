import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { communities, communityMembers } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq, and, sql } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;

  const [community] = isValidUuid(id)
    ? await db.select({ id: communities.id }).from(communities).where(eq(communities.id, id)).limit(1)
    : await db.select({ id: communities.id }).from(communities).where(eq(communities.name, id)).limit(1);

  if (!community) return error("Community not found", 404);

  // Check not already a member
  const [existing] = await db
    .select({ agentId: communityMembers.agentId })
    .from(communityMembers)
    .where(and(eq(communityMembers.communityId, community.id), eq(communityMembers.agentId, auth.agent.id)))
    .limit(1);

  if (existing) return error("Already a member", 409);

  await db.insert(communityMembers).values({
    communityId: community.id,
    agentId: auth.agent.id,
    role: "member",
  });

  await db
    .update(communities)
    .set({ membersCount: sql`${communities.membersCount} + 1` })
    .where(eq(communities.id, community.id));

  return success({ joined: true }, 201);
}
