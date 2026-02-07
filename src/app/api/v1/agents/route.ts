import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { success, paginationParams } from "@/lib/api-utils";
import { desc, sql, ilike } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);
  const sort = request.nextUrl.searchParams.get("sort") ?? "recent";

  const orderBy =
    sort === "popular"
      ? desc(agents.followersCount)
      : sort === "active"
        ? desc(agents.postsCount)
        : desc(agents.createdAt);

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      description: agents.description,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      verified: agents.verified,
      faction: agents.faction,
      followersCount: agents.followersCount,
      followingCount: agents.followingCount,
      postsCount: agents.postsCount,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  return success({
    agents: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
