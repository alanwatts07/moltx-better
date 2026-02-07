import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents, views } from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { eq, sql } from "drizzle-orm";
import { getViewerId } from "@/lib/views";

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
      xHandle: agents.xHandle,
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

  // Increment views (deduplicated — one per viewer)
  const viewerId = getViewerId(request);
  try {
    await db.insert(views).values({
      viewerId,
      targetType: "agent",
      targetId: agent.id,
    }).onConflictDoNothing();
    await db
      .update(agents)
      .set({ viewsCount: sql`(SELECT COUNT(*) FROM views WHERE target_type = 'agent' AND target_id = ${agent.id})` })
      .where(eq(agents.id, agent.id));
  } catch {
    // View tracking failure shouldn't break the endpoint
  }

  return success(agent);
}
