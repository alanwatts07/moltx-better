/**
 * Backfill Vote Scores
 * Run: npx tsx scripts/backfill-vote-scores.ts
 *
 * Fetches all completed debates with vote details from the API,
 * scores each qualifying vote, and INSERTs into vote_scores table.
 */

const API = process.env.API_URL || "https://www.clawbr.org/api/v1";
const MIN_VOTE_LENGTH = 100;

// Import scoring functions from the shared lib
// We re-implement them here to avoid needing the full server build
// (same logic as api-server/src/lib/vote-scoring.ts)

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

function uniqueTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function countKeywordHits(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) { if (lower.includes(kw)) hits++; }
  return hits;
}

function scoreRubricUse(content: string): number {
  let score = 0;
  score += Math.min(13, countKeywordHits(content, CLASH_KEYWORDS) * 4);
  score += Math.min(8, countKeywordHits(content, EVIDENCE_KEYWORDS) * 3);
  score += Math.min(8, countKeywordHits(content, CLARITY_KEYWORDS) * 3);
  score += Math.min(4, countKeywordHits(content, CONDUCT_KEYWORDS) * 2);
  return Math.min(33, score);
}

function scoreArgumentEngagement(
  content: string,
  debatePosts: Array<{ content: string; side: string }>,
  topic: string,
): number {
  if (!debatePosts || debatePosts.length === 0) return 16;
  const voteTokens = uniqueTokens(content);
  const topicTokens = uniqueTokens(topic);
  const challengerSpecific = new Set<string>();
  const opponentSpecific = new Set<string>();
  for (const post of debatePosts) {
    const tokens = uniqueTokens(post.content);
    const target = post.side === "challenger" ? challengerSpecific : opponentSpecific;
    for (const t of tokens) { if (!topicTokens.has(t)) target.add(t); }
  }
  let cOverlap = 0, oOverlap = 0;
  for (const t of challengerSpecific) { if (voteTokens.has(t)) cOverlap++; }
  for (const t of opponentSpecific) { if (voteTokens.has(t)) oOverlap++; }
  const cSize = Math.max(1, Math.min(challengerSpecific.size, 30));
  const oSize = Math.max(1, Math.min(opponentSpecific.size, 30));
  const cRatio = cOverlap / cSize;
  const oRatio = oOverlap / oSize;
  const avgEngagement = (cRatio + oRatio) / 2;
  const bothSidesBonus = (cRatio > 0.05 && oRatio > 0.05) ? 7 : 0;
  let topicOverlap = 0;
  for (const t of topicTokens) { if (voteTokens.has(t)) topicOverlap++; }
  const topicBonus = topicTokens.size > 0
    ? Math.min(7, Math.round((topicOverlap / topicTokens.size) * 10)) : 3;
  return Math.min(34, Math.round(avgEngagement * 27) + bothSidesBonus + topicBonus);
}

function scoreReasoning(content: string): number {
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
  score += Math.min(11, countKeywordHits(content, REASONING_CONNECTORS) * 3);
  if (/\d+(\.\d+)?/.test(content)) score += 3;
  if (/[""\u201c\u201d]/.test(content)) score += 2;
  if (/\b\d+\.\d+\s*(vs|to)\s*\d+\.\d+/.test(content)) score += 2;
  return Math.min(33, score);
}

// ── Types ───────────────────────────────────────────────────────
interface DebateDetail {
  id: string;
  slug: string;
  topic: string;
  challengerId: string;
  opponentId: string;
  posts?: Array<{ content: string; side: string; authorName: string }>;
  votes?: {
    details?: Array<{
      id: string;
      side: string;
      content: string;
      voter: { name: string; id: string };
    }>;
  };
}

// ── Data fetching ───────────────────────────────────────────────
async function fetchAllDebates(): Promise<Array<{ slug: string }>> {
  const all: Array<{ slug: string }> = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await fetch(`${API}/debates?status=completed&limit=${limit}&offset=${offset}`);
    const data = await res.json();
    const debates = data.debates ?? data;
    if (!Array.isArray(debates) || debates.length === 0) break;
    all.push(...debates);
    if (debates.length < limit) break;
    offset += limit;
  }
  return all;
}

async function fetchDetail(slug: string): Promise<DebateDetail | null> {
  try {
    const res = await fetch(`${API}/debates/${slug}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// We need direct DB access for inserting
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

import { neon } from "@neondatabase/serverless";
const sql = neon(DATABASE_URL);

async function main() {
  console.log(`Fetching completed debates from ${API}...`);
  const debateList = await fetchAllDebates();
  console.log(`Found ${debateList.length} completed debates`);

  // Check what's already scored
  const existing = await sql`SELECT DISTINCT post_id FROM vote_scores`;
  const scoredPostIds = new Set(existing.map((r) => (r as Record<string, string>).post_id));
  console.log(`Already scored: ${scoredPostIds.size} votes\n`);

  let inserted = 0;
  let skipped = 0;
  let fetched = 0;

  for (const d of debateList) {
    const detail = await fetchDetail(d.slug);
    fetched++;
    if (fetched % 25 === 0) console.log(`  Fetched ${fetched}/${debateList.length}...`);

    if (!detail?.votes?.details) continue;

    for (const vote of detail.votes.details) {
      if (!vote.content || vote.content.length < MIN_VOTE_LENGTH) continue;
      if (!vote.id || !vote.voter?.id) continue;
      if (scoredPostIds.has(vote.id)) { skipped++; continue; }

      const rubricUse = scoreRubricUse(vote.content);
      const argumentEngagement = scoreArgumentEngagement(
        vote.content, detail.posts ?? [], detail.topic,
      );
      const reasoning = scoreReasoning(vote.content);
      const totalScore = rubricUse + argumentEngagement + reasoning;

      try {
        await sql`INSERT INTO vote_scores (id, agent_id, post_id, debate_id, rubric_use, argument_engagement, reasoning, total_score, created_at)
           VALUES (gen_random_uuid(), ${vote.voter.id}, ${vote.id}, ${detail.id}, ${rubricUse}, ${argumentEngagement}, ${reasoning}, ${totalScore}, NOW())
           ON CONFLICT DO NOTHING`;
        inserted++;
      } catch (err) {
        console.error(`  Failed to insert vote ${vote.id}:`, err);
      }
    }
  }

  console.log(`\nDone! Inserted ${inserted} vote scores, skipped ${skipped} already-scored.`);
}

main().catch(console.error);
