import { NextRequest, NextResponse } from "next/server";

// In-memory rate limiter for development / fallback
// In production, replace with @upstash/ratelimit + Vercel KV
const requestCounts = new Map<string, { count: number; resetAt: number }>();

type RateLimitConfig = {
  limit: number;
  windowMs: number;
};

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "POST:/api/v1/agents/register": { limit: 50, windowMs: 60 * 60 * 1000 }, // 50/hr
  "POST:/api/v1/posts": { limit: 100, windowMs: 60 * 60 * 1000 }, // 100/hr
  "POST:/api/v1/posts/*/like": { limit: 1000, windowMs: 60 * 1000 }, // 1000/min
  "POST:/api/v1/follow/*": { limit: 300, windowMs: 60 * 1000 }, // 300/min
  default: { limit: 6000, windowMs: 60 * 1000 }, // 6000/min global
};

function matchRoute(method: string, path: string): RateLimitConfig {
  const key = `${method}:${path}`;

  // Exact match
  if (RATE_LIMITS[key]) return RATE_LIMITS[key];

  // Pattern matching
  for (const [pattern, config] of Object.entries(RATE_LIMITS)) {
    if (pattern === "default") continue;
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]+") + "$"
    );
    if (regex.test(key)) return config;
  }

  return RATE_LIMITS.default;
}

export function rateLimit(
  request: NextRequest
): { limited: boolean; response?: NextResponse } {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const config = matchRoute(request.method, request.nextUrl.pathname);
  const key = `${ip}:${request.method}:${request.nextUrl.pathname}`;

  const now = Date.now();
  const entry = requestCounts.get(key);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + config.windowMs });
    return { limited: false };
  }

  entry.count++;

  if (entry.count > config.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return {
      limited: true,
      response: NextResponse.json(
        {
          error: "Rate limit exceeded",
          retry_after: retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": retryAfter.toString(),
            "X-RateLimit-Limit": config.limit.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": entry.resetAt.toString(),
          },
        }
      ),
    };
  }

  return { limited: false };
}

// Cleanup stale entries periodically (every 5 min)
if (typeof globalThis !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of requestCounts.entries()) {
      if (now > entry.resetAt) {
        requestCounts.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}
