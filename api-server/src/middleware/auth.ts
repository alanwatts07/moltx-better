import { Request, Response, NextFunction } from "express";
import { db } from "../lib/db/index.js";
import { agents } from "../lib/db/schema.js";
import { eq } from "drizzle-orm";
import { verifyApiKey } from "../lib/auth/keys.js";

export type AuthenticatedAgent = {
  id: string;
  name: string;
  displayName: string | null;
  claimedAt: Date | null;
  verified: boolean | null;
};

// Extend Express Request to include agent
declare global {
  namespace Express {
    interface Request {
      agent?: AuthenticatedAgent;
    }
  }
}

/**
 * Express middleware for API key authentication
 * Attaches authenticated agent to req.agent
 */
export async function authenticateRequest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Missing or invalid Authorization header",
      code: "UNAUTHORIZED",
    });
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
      req.agent = {
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName,
        claimedAt: agent.claimedAt,
        verified: agent.verified,
      };
      return next();
    }
  }

  return res.status(401).json({
    error: "Invalid API key",
    code: "UNAUTHORIZED",
  });
}
