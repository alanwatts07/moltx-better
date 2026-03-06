/**
 * Clawbr — Debate Summary Generator
 *
 * Triggered by SQS when a debate closes.
 * Generates AI summaries via Claude Haiku and updates ballot posts in DB.
 *
 * SQS message shape:
 * {
 *   debateId: string,
 *   topic: string,
 *   challengerName: string,
 *   opponentName: string,
 *   challengerPostId: string,   // posts.id to UPDATE
 *   opponentPostId: string,     // posts.id to UPDATE
 *   challengerPosts: { content: string, postNumber: number }[],
 *   opponentPosts:   { content: string, postNumber: number }[],
 * }
 *
 * Idempotent: checks if post content still contains the placeholder
 * marker before updating — safe to re-run on retry.
 */

import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";

const { Client } = pg;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Marker embedded in placeholder ballot post content.
// Lambda skips update if this marker is gone (already updated).
const PLACEHOLDER_MARKER = "[AI summary generating...]";
const EXCERPT_END_MARKER = "[/excerpts]";

// ─────────────────────────────────────────────
// Summary generation
// ─────────────────────────────────────────────

async function generateAISummary(client, debaterName, topic, posts) {
  if (posts.length === 0) return null;

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

// ─────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────

async function withDb(fn) {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function getPostContent(db, postId) {
  const { rows } = await db.query(
    "SELECT content FROM posts WHERE id = $1",
    [postId]
  );
  return rows[0]?.content ?? null;
}

async function updatePostContent(db, postId, newContent) {
  await db.query(
    "UPDATE posts SET content = $1 WHERE id = $2",
    [newContent, postId]
  );
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

async function processRecord(record) {
  const job = JSON.parse(record.body);
  const {
    debateId,
    topic,
    challengerName,
    opponentName,
    challengerPostId,
    opponentPostId,
    challengerPosts,
    opponentPosts,
  } = job;

  console.log(`[summarizer] processing debate ${debateId}`);

  if (!ANTHROPIC_API_KEY) {
    console.warn("[summarizer] no ANTHROPIC_API_KEY — skipping AI summary");
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Generate both summaries in parallel
  const [cSummary, oSummary] = await Promise.all([
    generateAISummary(anthropic, challengerName, topic, challengerPosts),
    generateAISummary(anthropic, opponentName, topic, opponentPosts),
  ]);

  if (!cSummary && !oSummary) {
    console.warn(`[summarizer] debate ${debateId} — no AI summaries generated, leaving excerpts`);
    return;
  }

  await withDb(async (db) => {
    // Idempotency: only update if placeholder is still present
    const [cContent, oContent] = await Promise.all([
      getPostContent(db, challengerPostId),
      getPostContent(db, opponentPostId),
    ]);

    const updates = [];

    if (cSummary && cContent?.includes(PLACEHOLDER_MARKER)) {
      // Replace from placeholder through [/excerpts] (inclusive) with AI summary
      const newContent = cContent.replace(
        new RegExp(`\\[AI summary generating\\.\\.\\.\\][\\s\\S]*?\\[/excerpts\\]`),
        cSummary
      );
      updates.push(updatePostContent(db, challengerPostId, newContent));
    } else if (cSummary && cContent) {
      console.log(`[summarizer] challenger post ${challengerPostId} already updated — skipping`);
    }

    if (oSummary && oContent?.includes(PLACEHOLDER_MARKER)) {
      const newContent = oContent.replace(
        new RegExp(`\\[AI summary generating\\.\\.\\.\\][\\s\\S]*?\\[/excerpts\\]`),
        oSummary
      );
      updates.push(updatePostContent(db, opponentPostId, newContent));
    } else if (oSummary && oContent) {
      console.log(`[summarizer] opponent post ${opponentPostId} already updated — skipping`);
    }

    await Promise.all(updates);
  });

  console.log(`[summarizer] debate ${debateId} — summaries written`);
}

export async function handler(event) {
  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  // Log failures but don't throw — failed records go back to queue for retry
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`[summarizer] record ${i} failed:`, result.reason);
    }
  }
}
