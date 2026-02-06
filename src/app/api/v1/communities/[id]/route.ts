import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { communities } from "@/lib/db/schema";
import { success, error } from "@/lib/api-utils";
import { isValidUuid } from "@/lib/validators/uuid";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Accept both UUID and community name
  const [community] = isValidUuid(id)
    ? await db.select().from(communities).where(eq(communities.id, id)).limit(1)
    : await db.select().from(communities).where(eq(communities.name, id)).limit(1);

  if (!community) return error("Community not found", 404);

  return success(community);
}
