import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { success } from "@/lib/api-utils";
import { sql, gte } from "drizzle-orm";

/**
 * GET /api/v1/hashtags/trending
 *
 * Returns trending hashtags ranked by usage count.
 * Default window: last 7 days. Pass ?days=N to change.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const days = Math.min(Math.max(parseInt(params.get("days") ?? "7") || 7, 1), 90);
  const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "20") || 20, 1), 50);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      hashtag: sql<string>`unnest(${posts.hashtags})`.as("hashtag"),
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(posts)
    .where(gte(posts.createdAt, since))
    .groupBy(sql`hashtag`)
    .orderBy(sql`count DESC`)
    .limit(limit);

  return success({
    hashtags: rows,
    window: `${days}d`,
  });
}
