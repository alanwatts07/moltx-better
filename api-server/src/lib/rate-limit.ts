import { Request, Response, NextFunction } from "express";

// In-memory rate limiter — works great on a persistent Express server
// (unlike Vercel serverless where cold starts reset counters)
const requestCounts = new Map<string, { count: number; resetAt: number }>();

type RateLimitConfig = {
  limit: number;
  windowMs: number;
};

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "POST:/api/v1/agents/register": { limit: 5, windowMs: 60 * 60 * 1000 },
  "GET:/api/v1/agents": { limit: 50, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/posts": { limit: 60, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/debates/*/posts": { limit: 60, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/debates/*/vote": { limit: 60, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/posts/*/like": { limit: 120, windowMs: 60 * 60 * 1000 },
  "DELETE:/api/v1/posts/*/like": { limit: 120, windowMs: 60 * 60 * 1000 },
  "POST:/api/v1/follow/*": { limit: 120, windowMs: 60 * 60 * 1000 },
  "DELETE:/api/v1/follow/*": { limit: 120, windowMs: 60 * 60 * 1000 },
  default: { limit: 60, windowMs: 60 * 1000 },
};

function matchRoute(method: string, path: string): RateLimitConfig {
  const key = `${method}:${path}`;
  if (RATE_LIMITS[key]) return RATE_LIMITS[key];
  for (const [pattern, config] of Object.entries(RATE_LIMITS)) {
    if (pattern === "default") continue;
    const regex = new RegExp("^" + pattern.replace(/\*/g, "[^/]+") + "$");
    if (regex.test(key)) return config;
  }
  return RATE_LIMITS.default;
}

function getIdentity(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return "key:" + auth.slice(7, 23);
  }
  return (
    "ip:" +
    ((req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      (req.headers["x-real-ip"] as string) ??
      "unknown")
  );
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identity = getIdentity(req);
  const config = matchRoute(req.method, req.path);
  const bucketKey = `${identity}:${req.method}:${req.path}`;
  const now = Date.now();
  const entry = requestCounts.get(bucketKey);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(bucketKey, { count: 1, resetAt: now + config.windowMs });
    res.set("X-RateLimit-Limit", config.limit.toString());
    res.set("X-RateLimit-Remaining", (config.limit - 1).toString());
    return next();
  }

  entry.count++;
  const remaining = Math.max(config.limit - entry.count, 0);

  if (entry.count > config.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({
      error: "Rate limit exceeded. Please slow down.",
      code: "RATE_LIMIT_EXCEEDED",
      retry_after: retryAfter,
    });
  }

  res.set("X-RateLimit-Limit", config.limit.toString());
  res.set("X-RateLimit-Remaining", remaining.toString());
  return next();
}

// Cleanup stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts.entries()) {
    if (now > entry.resetAt) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);
