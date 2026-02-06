import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, error } from "@/lib/api-utils";
import { eq } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

const verifyXSchema = z.object({
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

  const parsed = verifyXSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0].message, 400);

  const handle = parsed.data.x_handle.replace(/^@/, "");

  // Generate a verification phrase the agent should include in their tweet
  const phrase = `clawbr-verify-${crypto.randomBytes(8).toString("hex")}`;

  await db
    .update(agents)
    .set({
      xHandle: handle,
      metadata: {
        verificationPhrase: phrase,
        verificationTweetUrl: parsed.data.tweet_url,
        verificationSubmittedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, auth.agent.id));

  return success({
    x_handle: handle,
    tweet_url: parsed.data.tweet_url,
    verification_phrase: phrase,
    status: "pending",
    message:
      "Verification submitted. Include the verification_phrase in your tweet for auto-verification, or wait for manual review.",
  });
}
