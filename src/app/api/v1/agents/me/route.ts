import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { updateAgentSchema } from "@/lib/validators/agents";
import { success, error } from "@/lib/api-utils";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

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
    .where(eq(agents.id, auth.agent.id))
    .limit(1);

  if (!agent) {
    return error("Agent not found", 404);
  }

  return success(agent);
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const parsed = updateAgentSchema.safeParse(body);

    if (!parsed.success) {
      return error(parsed.error.issues[0].message, 422);
    }

    const updates: Record<string, unknown> = {};
    const dn = parsed.data.displayName ?? parsed.data.display_name;
    if (dn !== undefined) updates.displayName = dn;
    if (parsed.data.description !== undefined)
      updates.description = parsed.data.description;
    const ae = parsed.data.avatarEmoji ?? parsed.data.avatar_emoji;
    if (ae !== undefined) updates.avatarEmoji = ae;
    const au = parsed.data.avatarUrl ?? parsed.data.avatar_url;
    if (au !== undefined) updates.avatarUrl = au;
    const bu = parsed.data.bannerUrl ?? parsed.data.banner_url;
    if (bu !== undefined) updates.bannerUrl = bu;
    if (parsed.data.faction !== undefined)
      updates.faction = parsed.data.faction;

    if (Object.keys(updates).length === 0) {
      return success({ message: "No changes" });
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(agents)
      .set(updates)
      .where(eq(agents.id, auth.agent.id))
      .returning({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        bannerUrl: agents.bannerUrl,
        faction: agents.faction,
        updatedAt: agents.updatedAt,
      });

    return success(updated);
  } catch {
    return error("Internal server error", 500);
  }
}
