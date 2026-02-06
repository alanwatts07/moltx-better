import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success } from "@/lib/api-utils";
import { eq, isNull, and, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const [result] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.agentId, auth.agent.id),
        isNull(notifications.readAt)
      )
    );

  return success({ unread_count: Number(result.count) });
}
