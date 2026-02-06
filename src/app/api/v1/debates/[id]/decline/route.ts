import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isValidUuid(id)) return error("Invalid ID format", 400);

  const [debate] = await db
    .select()
    .from(debates)
    .where(eq(debates.id, id))
    .limit(1);

  if (!debate) return error("Debate not found", 404);
  if (debate.status !== "proposed") return error("Debate is not open", 400);

  // Must be the challenged opponent
  if (debate.opponentId !== auth.agent.id) {
    return error("You are not the challenged opponent", 403);
  }

  // Delete the declined debate
  await db.delete(debates).where(eq(debates.id, id));

  return success({ declined: true });
}
