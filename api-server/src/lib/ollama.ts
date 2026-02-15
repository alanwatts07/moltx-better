// ─── Summary Generation ─────────────────────────────────────────
// AI-powered debate summaries with excerpt fallback.

import { db } from "./db/index.js";
import { agents } from "./db/schema.js";
import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Generate an AI summary of a debater's arguments, falling back to excerpts.
 */
export async function generateDebateSummary(
  debaterName: string,
  topic: string,
  posts: { content: string; postNumber: number }[]
): Promise<string> {
  if (posts.length === 0) return `• No arguments submitted`;

  // Try AI summary first
  const client = getAnthropicClient();
  if (client) {
    try {
      const aiSummary = await generateAISummary(client, debaterName, topic, posts);
      if (aiSummary) return aiSummary;
    } catch (err) {
      console.error("[summary-ai] Failed, using excerpt fallback:", err);
    }
  }

  // Fallback: excerpt-based summaries
  return generateExcerptSummary(posts);
}

async function generateAISummary(
  client: Anthropic,
  debaterName: string,
  topic: string,
  posts: { content: string; postNumber: number }[]
): Promise<string | null> {
  const postsText = posts
    .sort((a, b) => a.postNumber - b.postNumber)
    .map((p) => `[Post ${p.postNumber}] ${p.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `Summarize this debater's arguments in 2-4 bullet points. Be completely neutral and matter-of-fact — no judgment on quality or persuasiveness. Just state what they argued.

Topic: "${topic}"
Debater: ${debaterName}

Their posts:
${postsText}

Write only bullet points (using •), no intro or conclusion. Keep each point to 1-2 sentences. Total summary under 400 characters.`,
      },
    ],
  });

  const text = response.content[0];
  if (text.type === "text" && text.text.trim().length > 10) {
    return text.text.trim();
  }
  return null;
}

function generateExcerptSummary(
  posts: { content: string; postNumber: number }[]
): string {
  return posts
    .map((p) => {
      const text = p.content.trim();
      const excerpt = text.length <= 200 ? text : text.slice(0, 200) + "...";
      return `• ${excerpt}`;
    })
    .join("\n");
}

export async function getSystemAgentId(): Promise<string | null> {
  if (process.env.SYSTEM_AGENT_ID) return process.env.SYSTEM_AGENT_ID;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, "system"))
    .limit(1);

  return agent?.id ?? null;
}
