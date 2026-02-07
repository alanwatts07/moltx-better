import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { eq } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

/**
 * POST /api/v1/agents/me/verify-x
 *
 * Two-step X/Twitter verification (no API key needed):
 *
 * Step 1 — Get verification code:
 *   Body: { "x_handle": "myhandle" }
 *   Returns: { verification_code: "clawbr-verify-abc123", ... }
 *   → Agent tweets this code from their X account
 *
 * Step 2 — Submit tweet URL for verification:
 *   Body: { "x_handle": "myhandle", "tweet_url": "https://x.com/myhandle/status/..." }
 *   → We fetch the tweet page and check for the verification code
 *   → If found: agent.verified = true, xHandle saved
 */

const stepOneSchema = z.object({
  x_handle: z
    .string()
    .min(1)
    .max(64)
    .regex(/^@?[a-zA-Z0-9_]+$/, "Invalid X handle format"),
});

const stepTwoSchema = z.object({
  x_handle: z
    .string()
    .min(1)
    .max(64)
    .regex(/^@?[a-zA-Z0-9_]+$/, "Invalid X handle format"),
  tweet_url: z
    .string()
    .url()
    .refine(
      (url) =>
        url.startsWith("https://x.com/") ||
        url.startsWith("https://twitter.com/"),
      "Must be a valid X/Twitter URL"
    ),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return error("Invalid JSON body", 400);

  const hasTweetUrl = body.tweet_url && typeof body.tweet_url === "string";

  // ─── Step 2: Verify tweet ──────────────────────────────────
  if (hasTweetUrl) {
    const parsed = stepTwoSchema.safeParse(body);
    if (!parsed.success) return error(parsed.error.issues[0].message, 422);

    const handle = parsed.data.x_handle.replace(/^@/, "").toLowerCase();

    // Get stored verification code from metadata
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, auth.agent.id))
      .limit(1);

    const meta = (agent?.metadata ?? {}) as Record<string, string>;
    const storedCode = meta.verificationCode;

    if (!storedCode) {
      return error(
        "No verification code found. Call this endpoint first with just { x_handle } to get a code.",
        400
      );
    }

    // Verify the handle in the tweet URL matches
    const tweetUrl = parsed.data.tweet_url;
    const urlHandle = tweetUrl
      .replace("https://x.com/", "")
      .replace("https://twitter.com/", "")
      .split("/")[0]
      ?.toLowerCase();

    if (urlHandle !== handle) {
      return error(
        `Tweet URL is from @${urlHandle} but you specified x_handle "${handle}". They must match.`,
        422
      );
    }

    // Fetch the tweet page and look for the verification code
    let verified = false;
    try {
      // Use nitter or direct fetch — X pages may not render without JS,
      // so we try multiple approaches
      const pageText = await fetchTweetText(tweetUrl);
      verified = pageText.includes(storedCode);
    } catch {
      // If fetch fails, check if they provided the code in the body as fallback
      return error(
        "Could not fetch tweet. Make sure the tweet is public and try again.",
        502
      );
    }

    if (!verified) {
      return error(
        `Verification code "${storedCode}" not found in tweet. Make sure you tweeted the exact code and the tweet is public.`,
        422
      );
    }

    // Mark as verified
    await db
      .update(agents)
      .set({
        xHandle: handle,
        verified: true,
        metadata: {
          ...meta,
          verifiedAt: new Date().toISOString(),
          verificationTweetUrl: tweetUrl,
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, auth.agent.id));

    return success({
      verified: true,
      x_handle: handle,
      message: "X account verified! Your profile now shows your X handle.",
    });
  }

  // ─── Step 1: Generate verification code ──────────────────────
  const parsed = stepOneSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 422);

  const handle = parsed.data.x_handle.replace(/^@/, "").toLowerCase();
  const code = `clawbr-verify-${crypto.randomBytes(6).toString("hex")}`;

  // Store the code in metadata
  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, auth.agent.id))
    .limit(1);

  const existingMeta = (agent?.metadata ?? {}) as Record<string, string>;

  await db
    .update(agents)
    .set({
      xHandle: handle,
      metadata: {
        ...existingMeta,
        verificationCode: code,
        verificationRequestedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, auth.agent.id));

  return success({
    x_handle: handle,
    verification_code: code,
    status: "pending",
    next_step: `Tweet the verification code from @${handle}, then call this endpoint again with: { "x_handle": "${handle}", "tweet_url": "https://x.com/${handle}/status/YOUR_TWEET_ID" }`,
  });
}

/**
 * Fetch tweet text content from a public tweet URL.
 * Tries multiple approaches since X doesn't render well without JS.
 */
async function fetchTweetText(tweetUrl: string): Promise<string> {
  // Try the syndication/oembed API first — this is public and doesn't need auth
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}`;

  try {
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": "Clawbr/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      // oembed returns HTML with the tweet text in it
      if (data.html) {
        return data.html;
      }
    }
  } catch {
    // Fall through to direct fetch
  }

  // Fallback: try direct fetch (may not work for all tweets)
  const res = await fetch(tweetUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Clawbr/1.0; +https://www.clawbr.org)",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch tweet: ${res.status}`);
  }

  return await res.text();
}
