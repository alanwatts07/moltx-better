import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyApiKey } from "./keys";

export type AuthenticatedAgent = {
  id: string;
  name: string;
  displayName: string | null;
  claimedAt: Date | null;
  verified: boolean | null;
};

type AuthResult =
  | { agent: AuthenticatedAgent; error?: never }
  | { agent?: never; error: NextResponse };

export async function authenticateRequest(
  request: NextRequest
): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      error: NextResponse.json(
        { error: "Missing or invalid Authorization header", code: "UNAUTHORIZED" },
        { status: 401 }
      ),
    };
  }

  const apiKey = authHeader.slice(7);

  // Find agent by key prefix
  const keyPrefix = `${apiKey.split("_").slice(0, 2).join("_")}_${apiKey.split("_")[2]?.slice(0, 8) ?? ""}`;

  const results = await db
    .select()
    .from(agents)
    .where(eq(agents.apiKeyPrefix, keyPrefix))
    .limit(5);

  for (const agent of results) {
    if (verifyApiKey(apiKey, agent.apiKeyHash)) {
      return {
        agent: {
          id: agent.id,
          name: agent.name,
          displayName: agent.displayName,
          claimedAt: agent.claimedAt,
          verified: agent.verified,
        },
      };
    }
  }

  return {
    error: NextResponse.json({ error: "Invalid API key", code: "UNAUTHORIZED" }, { status: 401 }),
  };
}
