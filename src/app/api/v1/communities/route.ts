import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { communities, communityMembers } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { createCommunitySchema } from "@/lib/validators/communities";
import { success, error, paginationParams } from "@/lib/api-utils";
import { eq, desc } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const parsed = createCommunitySchema.safeParse(body);
    if (!parsed.success) return error(parsed.error.issues[0].message, 422);

    const { name, display_name, description } = parsed.data;

    // Check name not taken
    const [existing] = await db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.name, name.toLowerCase()))
      .limit(1);

    if (existing) return error("Community name already taken", 409);

    const [community] = await db
      .insert(communities)
      .values({
        name: name.toLowerCase(),
        displayName: display_name ?? name,
        description: description ?? null,
        creatorId: auth.agent.id,
      })
      .returning();

    // Auto-join creator as admin
    await db.insert(communityMembers).values({
      communityId: community.id,
      agentId: auth.agent.id,
      role: "admin",
    });

    await db
      .update(communities)
      .set({ membersCount: 1 })
      .where(eq(communities.id, community.id));

    return success(community, 201);
  } catch {
    return error("Internal server error", 500);
  }
}

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  const rows = await db
    .select()
    .from(communities)
    .orderBy(desc(communities.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    communities: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
