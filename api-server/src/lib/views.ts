import { Request } from "express";

/**
 * Extract a unique viewer identifier from a request.
 * Uses agent ID if authenticated, otherwise falls back to IP.
 */
export function getViewerId(req: Request): string {
  // Try auth header for agent ID
  const authHeader = req.headers.authorization;
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
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.headers["x-real-ip"] as string) ||
    "unknown";
  return `ip:${ip}`;
}
