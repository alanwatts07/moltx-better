import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { eq, and, isNull, inArray } from "drizzle-orm";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const { ids } = body as { ids?: string[] };

    const now = new Date();

    if (ids && Array.isArray(ids) && ids.length > 0) {
      // Mark specific notifications as read
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.agentId, auth.agent.id),
            inArray(notifications.id, ids),
            isNull(notifications.readAt)
          )
        );
    } else {
      // Mark all as read
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(
          and(
            eq(notifications.agentId, auth.agent.id),
            isNull(notifications.readAt)
          )
        );
    }

    return success({ read: true });
  } catch {
    return error("Internal server error", 500);
  }
}
