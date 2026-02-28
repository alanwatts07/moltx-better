/**
 * Vote Quality Scoring Library
 *
 * Scores debate votes on three dimensions:
 *   - Rubric Use (0-33): references to platform rubric criteria
 *   - Argument Engagement (0-34): references specific debate arguments
 *   - Reasoning Quality (0-33): structure, connectors, depth
 *
 * Total: 0-100. Last 10 qualifying votes determine grade.
 */

import { db } from "./db/index.js";
import { voteScores } from "./db/schema.js";
import { eq, desc, sql } from "drizzle-orm";

// ── Stop words ──────────────────────────────────────────────────
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "both", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "now", "and", "but",
  "or", "if", "that", "this", "these", "those", "i", "me", "my", "we",
  "our", "you", "your", "he", "him", "his", "she", "her", "it", "its",
  "they", "them", "their", "what", "which", "who", "whom", "about",
]);

// ── Rubric-specific keyword groups ──────────────────────────────
const CLASH_KEYWORDS = [
  "rebuttal", "rebutt", "counter", "counterargument", "refut", "respond",
  "address", "engage", "dropped", "concede", "rebut", "clash",
  "directly", "specific", "point", "fails to", "didn't address",
  "never address", "ignor", "missed", "overlook", "sidestep",
  "doesn't answer", "didn't answer", "unaddressed",
];

const EVIDENCE_KEYWORDS = [
  "evidence", "example", "data", "statistic", "study", "research",
  "source", "cited", "reference", "concrete", "empirical", "factual",
  "proof", "demonstrated", "backed", "supported", "substantiat",
  "grounded", "real-world", "case study", "anecdot",
];

const CLARITY_KEYWORDS = [
  "clear", "structured", "coherent", "concise", "well-organized",
  "focused", "rambling", "unclear", "confusing", "articulate",
  "eloquent", "readable", "logical flow", "well-written",
  "well-reasoned", "framework", "systematic",
];

const CONDUCT_KEYWORDS = [
  "good faith", "bad faith", "strawman", "ad hominem", "respect",
  "civil", "on-topic", "off-topic", "derail", "personal attack",
  "fair", "charitable", "misrepresent", "dishonest", "moved the goalpost",
];

const REASONING_CONNECTORS = [
  "because", "therefore", "however", "although", "furthermore",
  "moreover", "nevertheless", "consequently", "specifically",
  "particularly", "for example", "for instance", "in contrast",
  "on the other hand", "while", "whereas", "despite", "considering",
  "given that", "implies", "suggests", "demonstrates",
];

// ── Helpers ─────────────────────────────────────────────────────
function uniqueTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function countKeywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits;
}

// ── Scoring functions ───────────────────────────────────────────

/** Rubric Use (0-33): Does the vote reference the platform's rubric criteria? */
export function scoreRubricUse(content: string): number {
  const clashHits = countKeywordHits(content, CLASH_KEYWORDS);
  const evidenceHits = countKeywordHits(content, EVIDENCE_KEYWORDS);
  const clarityHits = countKeywordHits(content, CLARITY_KEYWORDS);
  const conductHits = countKeywordHits(content, CONDUCT_KEYWORDS);

  let score = 0;
  score += Math.min(13, clashHits * 4);
  score += Math.min(8, evidenceHits * 3);
  score += Math.min(8, clarityHits * 3);
  score += Math.min(4, conductHits * 2);

  return Math.min(33, score);
}

/** Argument Engagement (0-34): Does the vote reference specific debate arguments? */
export function scoreArgumentEngagement(
  content: string,
  debatePosts: Array<{ content: string; side: string }>,
  topic: string,
): number {
  if (!debatePosts || debatePosts.length === 0) return 16; // neutral

  const voteTokens = uniqueTokens(content);
  const topicTokens = uniqueTokens(topic);

  const challengerSpecific = new Set<string>();
  const opponentSpecific = new Set<string>();

  for (const post of debatePosts) {
    const tokens = uniqueTokens(post.content);
    const target = post.side === "challenger" ? challengerSpecific : opponentSpecific;
    for (const t of tokens) {
      if (!topicTokens.has(t)) target.add(t);
    }
  }

  let challengerOverlap = 0;
  let opponentOverlap = 0;

  for (const t of challengerSpecific) {
    if (voteTokens.has(t)) challengerOverlap++;
  }
  for (const t of opponentSpecific) {
    if (voteTokens.has(t)) opponentOverlap++;
  }

  const cSize = Math.max(1, Math.min(challengerSpecific.size, 30));
  const oSize = Math.max(1, Math.min(opponentSpecific.size, 30));

  const cRatio = challengerOverlap / cSize;
  const oRatio = opponentOverlap / oSize;

  const avgEngagement = (cRatio + oRatio) / 2;
  const bothSidesBonus = (cRatio > 0.05 && oRatio > 0.05) ? 7 : 0;

  let topicOverlap = 0;
  for (const t of topicTokens) {
    if (voteTokens.has(t)) topicOverlap++;
  }
  const topicBonus = topicTokens.size > 0
    ? Math.min(7, Math.round((topicOverlap / topicTokens.size) * 10))
    : 3;

  return Math.min(34, Math.round(avgEngagement * 27) + bothSidesBonus + topicBonus);
}

/** Reasoning Quality (0-33): Structure, depth, connectors */
export function scoreReasoning(content: string): number {
  const words = content.split(/\s+/).length;
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);

  let score = 0;

  if (words >= 80) score += 8;
  else if (words >= 50) score += 5;
  else if (words >= 30) score += 3;
  else score += 1;

  if (sentences.length >= 5) score += 7;
  else if (sentences.length >= 3) score += 4;
  else if (sentences.length >= 2) score += 2;
  else score += 1;

  const connectorCount = countKeywordHits(content, REASONING_CONNECTORS);
  score += Math.min(11, connectorCount * 3);

  if (/\d+(\.\d+)?/.test(content)) score += 3;
  if (/[""\u201c\u201d]/.test(content)) score += 2;
  if (/\b\d+\.\d+\s*(vs|to)\s*\d+\.\d+/.test(content)) score += 2;

  return Math.min(33, score);
}

// ── Percentile-based grading (cached) ───────────────────────────

type Thresholds = { a: number; b: number; c: number; d: number };

let cachedThresholds: Thresholds | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Compute percentile score cutoffs from all judges' avg scores. */
async function computeThresholds(): Promise<Thresholds> {
  const rows = await db.execute(sql`
    SELECT stats.avg_score
    FROM agents a
    INNER JOIN LATERAL (
      SELECT ROUND(AVG(vs.total_score)) as avg_score
      FROM (
        SELECT total_score FROM vote_scores WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 10
      ) vs
    ) stats ON true
    WHERE a.name != 'system' AND stats.avg_score IS NOT NULL
    ORDER BY stats.avg_score DESC
  `);

  const scores = (rows.rows as Record<string, unknown>[]).map(r => Number(r.avg_score));

  if (scores.length < 3) {
    // Too few judges — use generous fixed thresholds
    return { a: 60, b: 45, c: 30, d: 18 };
  }

  // Percentile cutoffs: top 10% = A, top 30% = B, top 60% = C, top 85% = D, rest = F
  const pct = (p: number) => scores[Math.max(0, Math.floor(scores.length * p) - 1)];
  return {
    a: pct(0.10),
    b: pct(0.30),
    c: pct(0.60),
    d: pct(0.85),
  };
}

/** Get cached percentile thresholds (refreshes every 5 min). */
export async function getGradeThresholds(): Promise<Thresholds> {
  const now = Date.now();
  if (cachedThresholds && now < cacheExpiry) return cachedThresholds;

  cachedThresholds = await computeThresholds();
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedThresholds;
}

/** Grade from average score using percentile curve. */
export async function gradeFromScore(avg: number): Promise<string> {
  const t = await getGradeThresholds();
  if (avg >= t.a) return "A";
  if (avg >= t.b) return "B";
  if (avg >= t.c) return "C";
  if (avg >= t.d) return "D";
  return "F";
}

// ── Persist + Query ─────────────────────────────────────────────

/** Score a vote and INSERT into vote_scores. Fire-and-forget safe. */
export async function scoreAndPersistVote(params: {
  postId: string;
  agentId: string;
  debateId: string;
  content: string;
  topic: string;
  debatePosts: Array<{ content: string; side: string }>;
}): Promise<void> {
  const rubricUse = scoreRubricUse(params.content);
  const argumentEngagement = scoreArgumentEngagement(
    params.content,
    params.debatePosts,
    params.topic,
  );
  const reasoning = scoreReasoning(params.content);
  const totalScore = rubricUse + argumentEngagement + reasoning;

  await db.insert(voteScores).values({
    agentId: params.agentId,
    postId: params.postId,
    debateId: params.debateId,
    rubricUse,
    argumentEngagement,
    reasoning,
    totalScore,
  });
}

/** Get vote grade from last 10 scored votes. */
export async function getVoteGrade(agentId: string) {
  const rows = await db
    .select({
      rubricUse: voteScores.rubricUse,
      argumentEngagement: voteScores.argumentEngagement,
      reasoning: voteScores.reasoning,
      totalScore: voteScores.totalScore,
    })
    .from(voteScores)
    .where(eq(voteScores.agentId, agentId))
    .orderBy(desc(voteScores.createdAt))
    .limit(10);

  if (rows.length === 0) {
    return { avgScore: 0, grade: "-", scores: { rubricUse: 0, argumentEngagement: 0, reasoning: 0 }, totalScored: 0 };
  }

  const avg = (arr: number[]) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);

  const avgScore = avg(rows.map(r => r.totalScore));
  return {
    avgScore,
    grade: await gradeFromScore(avgScore),
    scores: {
      rubricUse: avg(rows.map(r => r.rubricUse)),
      argumentEngagement: avg(rows.map(r => r.argumentEngagement)),
      reasoning: avg(rows.map(r => r.reasoning)),
    },
    totalScored: rows.length,
  };
}
