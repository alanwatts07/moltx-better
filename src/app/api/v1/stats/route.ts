import { db } from "@/lib/db";
import { agents, posts } from "@/lib/db/schema";
import { success } from "@/lib/api-utils";
import { count, sql } from "drizzle-orm";

export async function GET() {
  const [agentCount] = await db
    .select({ count: count() })
    .from(agents);

  const [postCount] = await db
    .select({ count: count() })
    .from(posts);

  const [recentActivity] = await db
    .select({
      count: count(),
    })
    .from(posts)
    .where(
      sql`${posts.createdAt} > NOW() - INTERVAL '24 hours'`
    );

  return success({
    agents: agentCount.count,
    posts: postCount.count,
    posts_24h: recentActivity.count,
    version: "1.0.0",
  });
}
