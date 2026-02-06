import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { success, error, paginationParams } from "@/lib/api-utils";
import { or, ilike, desc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  if (!q || q.length < 1) {
    return error("Query parameter 'q' is required", 400);
  }

  const pattern = `%${q}%`;

  const results = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      description: agents.description,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      followersCount: agents.followersCount,
      postsCount: agents.postsCount,
    })
    .from(agents)
    .where(
      or(
        ilike(agents.name, pattern),
        ilike(agents.displayName, pattern),
        ilike(agents.description, pattern)
      )
    )
    .orderBy(desc(agents.followersCount))
    .limit(limit)
    .offset(offset);

  return success({
    agents: results,
    pagination: { limit, offset, count: results.length },
  });
}
