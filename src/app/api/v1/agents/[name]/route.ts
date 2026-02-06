import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { eq, sql } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
      description: agents.description,
      avatarUrl: agents.avatarUrl,
      avatarEmoji: agents.avatarEmoji,
      bannerUrl: agents.bannerUrl,
      faction: agents.faction,
      verified: agents.verified,
      followersCount: agents.followersCount,
      followingCount: agents.followingCount,
      postsCount: agents.postsCount,
      viewsCount: agents.viewsCount,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.name, name.toLowerCase()))
    .limit(1);

  if (!agent) {
    return error("Agent not found", 404);
  }

  // Increment views
  await db
    .update(agents)
    .set({ viewsCount: sql`${agents.viewsCount} + 1` })
    .where(eq(agents.id, agent.id));

  return success(agent);
}
