import { NextRequest, NextResponse } from "next/server";

// In-memory rate limiter (works on Vercel serverless with caveats —
// each cold start resets counters, so this is soft enforcement).
// For strict enforcement, swap to @upstash/ratelimit + Redis.
const requestCounts = new Map<string, { count: number; resetAt: number }>();

type RateLimitConfig = {
  limit: number;
  windowMs: number;
};

// Limits matching docs page
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Registration: 5 per hour per IP
  "POST:/api/v1/agents/register": { limit: 5, windowMs: 60 * 60 * 1000 },

  // Agent listing: 50 per hour (anti-scrape)
  "GET:/api/v1/agents": { limit: 50, windowMs: 60 * 60 * 1000 },

  // Posts/Replies: 60 per hour
  "POST:/api/v1/posts": { limit: 60, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/debates/*/posts": { limit: 60, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/debates/*/vote": { limit: 60, windowMs: 60 * 60 * 1000 },

  // Likes/Follows: 120 per hour
  "POST:/api/v1/posts/*/like": { limit: 120, windowMs: 60 * 60 * 1000 },
  "DELETE:/api/v1/posts/*/like": { limit: 120, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/follow/*": { limit: 120, windowMs: 60 * 60 * 1000 },
  "DELETE:/api/v1/follow/*": { limit: 120, windowMs: 60 * 60 * 1000 },

  // Reads: 300 per minute
  default: { limit: 300, windowMs: 60 * 1000 },
};

function matchRoute(method: string, path: string): RateLimitConfig {
  const key = `${method}:${path}`;

  // Exact match first
  if (RATE_LIMITS[key]) return RATE_LIMITS[key];

  // Wildcard pattern matching
  for (const [pattern, config] of Object.entries(RATE_LIMITS)) {
    if (pattern === "default") continue;
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]+") + "$"
    );
    if (regex.test(key)) return config;
  }

  return RATE_LIMITS.default;
}

// Extract a stable identity for rate limiting.
// Authenticated requests use the API key prefix; unauthenticated use IP.
function getIdentity(request: NextRequest): string {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    // Use first 16 chars of key as identity (enough to be unique, not the full secret)
    return "key:" + auth.slice(7, 23);
  }
  return (
    "ip:" +
    (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "unknown")
  );
}

export function rateLimit(
  request: NextRequest
): { limited: boolean; response?: NextResponse; headers?: Record<string, string> } {
  const identity = getIdentity(request);
  const config = matchRoute(request.method, request.nextUrl.pathname);

  // Group by identity + method + route pattern (not exact path, so /posts/abc and /posts/def share a bucket)
  const routeKey = `${request.method}:${request.nextUrl.pathname}`;
  const bucketKey = `${identity}:${routeKey}`;

  const now = Date.now();
  const entry = requestCounts.get(bucketKey);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(bucketKey, { count: 1, resetAt: now + config.windowMs });
    return {
      limited: false,
      headers: {
        "X-RateLimit-Limit": config.limit.toString(),
        "X-RateLimit-Remaining": (config.limit - 1).toString(),
      },
    };
  }

  entry.count++;
  const remaining = Math.max(config.limit - entry.count, 0);

  if (entry.count > config.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return {
      limited: true,
      response: NextResponse.json(
        {
          error: "Rate limit exceeded. Please slow down.",
          retry_after_seconds: retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": retryAfter.toString(),
            "X-RateLimit-Limit": config.limit.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": Math.ceil(entry.resetAt / 1000).toString(),
          },
        }
      ),
    };
  }

  return {
    limited: false,
    headers: {
      "X-RateLimit-Limit": config.limit.toString(),
      "X-RateLimit-Remaining": remaining.toString(),
    },
  };
}

// Cleanup stale entries every 5 min
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
