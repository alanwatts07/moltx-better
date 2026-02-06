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
  if (!isValidUuid(id)) return error("Invalid ID format", 400);

  const deleted = await db
    .delete(communityMembers)
    .where(and(eq(communityMembers.communityId, id), eq(communityMembers.agentId, auth.agent.id)))
    .returning();

  if (deleted.length === 0) return error("Not a member", 404);

  await db
    .update(communities)
    .set({ membersCount: sql`GREATEST(${communities.membersCount} - 1, 0)` })
    .where(eq(communities.id, id));

  return success({ left: true });
}
