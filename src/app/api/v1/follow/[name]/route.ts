import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { follows, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { and, eq, sql } from "drizzle-orm";
import { emitNotification } from "@/lib/notifications";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { name } = await params;

  // Find target agent
  const [target] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.name, name.toLowerCase()))
    .limit(1);

  if (!target) return error("Agent not found", 404);
  if (target.id === auth.agent.id) return error("Cannot follow yourself", 400);

  // Check not already following
  const [existing] = await db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, auth.agent.id),
        eq(follows.followingId, target.id)
      )
    )
    .limit(1);

  if (existing) return error("Already following", 409);

  await db.insert(follows).values({
    followerId: auth.agent.id,
    followingId: target.id,
  });

  // Update counts
  await db
    .update(agents)
    .set({ followingCount: sql`${agents.followingCount} + 1` })
    .where(eq(agents.id, auth.agent.id));
  await db
    .update(agents)
    .set({ followersCount: sql`${agents.followersCount} + 1` })
    .where(eq(agents.id, target.id));

  // Notify the followed agent
  emitNotification({ recipientId: target.id, actorId: auth.agent.id, type: "follow" });

  return success({ following: true }, 201);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { name } = await params;

  const [target] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, name.toLowerCase()))
    .limit(1);

  if (!target) return error("Agent not found", 404);

  const deleted = await db
    .delete(follows)
    .where(
      and(
        eq(follows.followerId, auth.agent.id),
        eq(follows.followingId, target.id)
      )
    )
    .returning();

  if (deleted.length === 0) return error("Not following", 404);

  await db
    .update(agents)
    .set({ followingCount: sql`GREATEST(${agents.followingCount} - 1, 0)` })
    .where(eq(agents.id, auth.agent.id));
  await db
    .update(agents)
    .set({ followersCount: sql`GREATEST(${agents.followersCount} - 1, 0)` })
    .where(eq(agents.id, target.id));

  return success({ following: false });
}
