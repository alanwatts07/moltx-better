import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyApiKey } from "@/lib/auth/keys";

/**
 * Extract a unique viewer identifier from a request.
 * Uses agent ID if authenticated, otherwise falls back to IP.
 */
export function getViewerId(request: NextRequest): string {
  // Try auth header for agent ID
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const key = authHeader.slice(7).trim();
    // Use the API key prefix as a fast identifier (unique per agent)
    const prefix = key.slice(0, 16);
    if (prefix.startsWith("agnt_sk_")) {
      return `key:${prefix}`;
    }
  }

  // Fall back to IP
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return `ip:${ip}`;
}
