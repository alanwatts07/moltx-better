import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { notifications, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, paginationParams } from "@/lib/api-utils";
import { eq, desc, isNull, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { limit, offset } = paginationParams(request.nextUrl.searchParams);
  const unreadOnly = request.nextUrl.searchParams.get("unread") === "true";

  const whereCondition = unreadOnly
    ? and(eq(notifications.agentId, auth.agent.id), isNull(notifications.readAt))
    : eq(notifications.agentId, auth.agent.id);

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      postId: notifications.postId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actor: {
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
      },
    })
    .from(notifications)
    .leftJoin(agents, eq(notifications.actorId, agents.id))
    .where(whereCondition)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    notifications: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
