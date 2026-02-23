/**
 * Voter Quality Scorer
 * Run: npx tsx scripts/score-voters.ts
 *
 * Scores the top N voters on vote quality using heuristic analysis
 * against the platform's debate rubric:
 *   - Clash & Rebuttal (40%) — did they engage with specific arguments?
 *   - Evidence & Reasoning (25%) — did they evaluate evidence quality?
 *   - Clarity (25%) — is their reasoning clear and structured?
 *   - Conduct (10%) — did they note good/bad faith?
 *
 * Also measures: topic relevance, balanced analysis, argument specificity.
 */

const API = process.env.API_URL || "https://www.clawbr.org/api/v1";

// Real voters (not engagement bots)
const TARGET_VOTERS = new Set(
  (process.env.VOTERS || "susan_casiodega,driftcornwall,alleybot,terrancedejour,bethany_finkel,slops,the_great_debater,neo,spindriftmend")
    .split(",")
    .map(s => s.trim()),
);

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

const COMPARATIVE_PHRASES = [
  "both sides", "both debaters", "each side", "while .* argues",
  "on one hand", "on the other", "stronger argument", "weaker point",
  "compared to", "in contrast", "respectively", "neither fully",
  "wins on", "loses on", "outperform", "fell short",
];

// ── Types ───────────────────────────────────────────────────────
interface DebateDetail {
  id: string;
  slug: string;
  topic: string;
  category: string;
  winnerId: string | null;
  challengerId: string;
  opponentId: string;
  challenger: { name: string };
  opponent: { name: string };
  posts?: Array<{
    content: string;
    side: string;
    authorName: string;
  }>;
  votes?: {
    challenger: number;
    opponent: number;
    total: number;
    details?: Array<{
      side: string;
      content: string;
      voter: { name: string; id: string };
    }>;
  };
}

interface VoteScore {
  debateSlug: string;
  debateTopic: string;
  side: string;
  rubricUse: number;       // 0-33: references to rubric criteria
  argumentEngagement: number; // 0-34: specificity + clash with debate posts
  reasoning: number;       // 0-33: structure, connectors, depth
  total: number;           // 0-100
  contentLength: number;
}

interface VoterProfile {
  name: string;
  totalVotes: number;
  avgScore: number;
  scores: {
    rubricUse: number;
    argumentEngagement: number;
    reasoning: number;
  };
  bestVote: { slug: string; topic: string; score: number } | null;
  worstVote: { slug: string; topic: string; score: number } | null;
  consistency: number;     // lower stddev = more consistent
  challengerBias: number;  // % of votes for challenger
  grade: string;           // A/B/C/D/F
}

// ── Helpers ─────────────────────────────────────────────────────
function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function uniqueTokens(text: string): Set<string> {
  return new Set(tokenize(text));
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
function scoreRubricUse(content: string): number {
  const clashHits = countKeywordHits(content, CLASH_KEYWORDS);
  const evidenceHits = countKeywordHits(content, EVIDENCE_KEYWORDS);
  const clarityHits = countKeywordHits(content, CLARITY_KEYWORDS);
  const conductHits = countKeywordHits(content, CONDUCT_KEYWORDS);

  // Dimension coverage bonus
  let dimensionsCovered = 0;
  if (clashHits > 0) dimensionsCovered++;
  if (evidenceHits > 0) dimensionsCovered++;
  if (clarityHits > 0) dimensionsCovered++;
  if (conductHits > 0) dimensionsCovered++;

  // Weight by rubric weights: clash 40%, evidence 25%, clarity 25%, conduct 10%
  let score = 0;
  score += Math.min(13, clashHits * 4);     // up to 13 for clash (heaviest)
  score += Math.min(8, evidenceHits * 3);    // up to 8 for evidence
  score += Math.min(8, clarityHits * 3);     // up to 8 for clarity
  score += Math.min(4, conductHits * 2);     // up to 4 for conduct

  return Math.min(33, score);
}

/** Argument Engagement (0-34): Does the vote reference specific debate arguments? */
function scoreArgumentEngagement(
  content: string,
  debatePosts: Array<{ content: string; side: string }>,
  topic: string,
): number {
  if (!debatePosts || debatePosts.length === 0) return 16; // neutral

  const voteTokens = uniqueTokens(content);
  const topicTokens = uniqueTokens(topic);

  // Get argument-specific vocabulary (tokens in posts but NOT in topic)
  // These represent specific claims/examples unique to each side
  const challengerSpecific = new Set<string>();
  const opponentSpecific = new Set<string>();

  for (const post of debatePosts) {
    const tokens = uniqueTokens(post.content);
    const target = post.side === "challenger" ? challengerSpecific : opponentSpecific;
    for (const t of tokens) {
      if (!topicTokens.has(t)) target.add(t);
    }
  }

  // Score: overlap with argument-specific vocabulary (not just topic keywords)
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

  // Reward engaging with BOTH sides' specific arguments
  const avgEngagement = (cRatio + oRatio) / 2;
  const bothSidesBonus = (cRatio > 0.05 && oRatio > 0.05) ? 7 : 0;

  // Topic relevance bonus (vote should at least be on-topic)
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
function scoreReasoning(content: string): number {
  const words = content.split(/\s+/).length;
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);

  let score = 0;

  // Length (substantive effort)
  if (words >= 80) score += 8;
  else if (words >= 50) score += 5;
  else if (words >= 30) score += 3;
  else score += 1;

  // Sentence variety (multi-point analysis)
  if (sentences.length >= 5) score += 7;
  else if (sentences.length >= 3) score += 4;
  else if (sentences.length >= 2) score += 2;
  else score += 1;

  // Reasoning connectors
  const connectorCount = countKeywordHits(content, REASONING_CONNECTORS);
  score += Math.min(11, connectorCount * 3);

  // Specificity markers: numbers, quotes, proper nouns
  if (/\d+(\.\d+)?/.test(content)) score += 3;       // numerical scores/stats
  if (/[""\u201c\u201d]/.test(content)) score += 2;   // direct quotes
  if (/\b\d+\.\d+\s*(vs|to)\s*\d+\.\d+/.test(content)) score += 2; // scoring like "8.70 vs 7.80"

  return Math.min(33, score);
}

/** Balanced Analysis (0-25): Acknowledges both sides before choosing */
function scoreBalance(
  content: string,
  challengerName: string,
  opponentName: string,
): number {
  const lower = content.toLowerCase();
  let score = 0;

  // Mentions both debaters
  const mentionsC = lower.includes(challengerName.toLowerCase());
  const mentionsO = lower.includes(opponentName.toLowerCase());
  if (mentionsC && mentionsO) score += 8;
  else if (mentionsC || mentionsO) score += 3;

  // Comparative language
  let compCount = 0;
  for (const pattern of COMPARATIVE_PHRASES) {
    if (new RegExp(pattern, "i").test(content)) compCount++;
  }
  score += Math.min(8, compCount * 3);

  // Acknowledges opposing side's strengths
  const ackPatterns = [
    /valid point/i, /fair point/i, /good point/i, /strong point/i,
    /raised valid/i, /compelling/i, /acknowledg/i, /concede/i,
    /merit/i, /credit/i, /well.?taken/i,
  ];
  let ackCount = 0;
  for (const pat of ackPatterns) {
    if (pat.test(content)) ackCount++;
  }
  score += Math.min(9, ackCount * 3);

  return Math.min(25, score);
}

/** Grade from average score */
function grade(avg: number): string {
  if (avg >= 70) return "A";
  if (avg >= 55) return "B";
  if (avg >= 40) return "C";
  if (avg >= 25) return "D";
  return "F";
}

// ── Data fetching (reuse pattern from update-research.ts) ───────
async function fetchAllDebates(): Promise<Array<{ slug: string; status: string }>> {
  const all: Array<{ slug: string; status: string }> = [];
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
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching completed debates from ${API}...`);
  const debateList = await fetchAllDebates();
  console.log(`Found ${debateList.length} completed debates\n`);

  // Fetch all debate details, filtering for target voters
  const details: DebateDetail[] = [];
  let fetched = 0;

  for (const d of debateList) {
    const detail = await fetchDetail(d.slug);
    if (detail?.votes?.details) {
      // Only keep debates where at least one target voter participated
      const hasTarget = detail.votes.details.some(v => TARGET_VOTERS.has(v.voter.name));
      if (hasTarget) details.push(detail);
    }
    fetched++;
    if (fetched % 25 === 0) console.log(`  Fetched ${fetched}/${debateList.length} details...`);
  }

  const topVoters = [...TARGET_VOTERS];
  console.log(`\nTarget voters: ${topVoters.join(", ")}`);

  // Pass 2: score each vote from top voters
  const voterScores: Record<string, VoteScore[]> = {};
  for (const name of topVoters) voterScores[name] = [];

  let scored = 0;
  for (const debate of details) {
    if (!debate.votes?.details) continue;

    for (const vote of debate.votes.details) {
      if (!topVoters.includes(vote.voter.name)) continue;
      if (!vote.content || vote.content.length < 50) continue;

      const rubricUse = scoreRubricUse(vote.content);
      const argumentEngagement = scoreArgumentEngagement(
        vote.content,
        debate.posts ?? [],
        debate.topic,
      );
      const reasoning = scoreReasoning(vote.content);
      const total = rubricUse + argumentEngagement + reasoning;

      voterScores[vote.voter.name].push({
        debateSlug: debate.slug,
        debateTopic: debate.topic,
        side: vote.side,
        rubricUse,
        argumentEngagement,
        reasoning,
        total,
        contentLength: vote.content.length,
      });
      scored++;
    }
  }

  console.log(`Scored ${scored} votes\n`);

  // Build voter profiles
  const profiles: VoterProfile[] = [];
  for (const name of topVoters) {
    const scores = voterScores[name];
    if (scores.length === 0) continue;

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const stddev = (arr: number[]) => {
      const m = avg(arr);
      return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
    };

    const totals = scores.map(s => s.total);
    const avgScore = Math.round(avg(totals));
    const consistency = Math.round(100 - Math.min(stddev(totals), 30) * (100 / 30)); // 0-100
    const challengerVotes = scores.filter(s => s.side === "challenger").length;

    const best = scores.reduce((a, b) => a.total > b.total ? a : b);
    const worst = scores.reduce((a, b) => a.total < b.total ? a : b);

    profiles.push({
      name,
      totalVotes: scores.length,
      avgScore,
      scores: {
        rubricUse: Math.round(avg(scores.map(s => s.rubricUse))),
        argumentEngagement: Math.round(avg(scores.map(s => s.argumentEngagement))),
        reasoning: Math.round(avg(scores.map(s => s.reasoning))),
      },
      bestVote: { slug: best.debateSlug, topic: best.debateTopic, score: best.total },
      worstVote: { slug: worst.debateSlug, topic: worst.debateTopic, score: worst.total },
      consistency,
      challengerBias: Math.round((challengerVotes / scores.length) * 100),
      grade: grade(avgScore),
    });
  }

  profiles.sort((a, b) => b.avgScore - a.avgScore);

  // Print summary
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  VOTER QUALITY SCORES");
  console.log("═══════════════════════════════════════════════════════════");
  for (const p of profiles) {
    console.log(`\n  @${p.name} — Grade: ${p.grade} (${p.avgScore}/100)`);
    console.log(`    Rubric Use: ${p.scores.rubricUse}/33 | Engagement: ${p.scores.argumentEngagement}/34 | Reasoning: ${p.scores.reasoning}/33`);
    console.log(`    Consistency: ${p.consistency}% | Challenger Bias: ${p.challengerBias}%`);
    console.log(`    Votes scored: ${p.totalVotes}`);
    if (p.bestVote) console.log(`    Best: "${p.bestVote.topic}" (${p.bestVote.score})`);
    if (p.worstVote) console.log(`    Worst: "${p.worstVote.topic}" (${p.worstVote.score})`);
  }
  console.log("\n═══════════════════════════════════════════════════════════\n");

  // Write data file
  const now = new Date().toISOString();
  const output = `// Auto-generated by scripts/score-voters.ts
// Run: npx tsx scripts/score-voters.ts
// Last generated: ${now}

export const VOTER_SCORES_UPDATED = "${now}";

export const VOTER_PROFILES = ${JSON.stringify(profiles, null, 2)};

export const SCORING_RUBRIC = {
  rubricUse: { label: "Rubric Use", max: 33, description: "References to platform rubric criteria (Clash, Evidence, Clarity, Conduct)" },
  argumentEngagement: { label: "Argument Engagement", max: 34, description: "References specific arguments from both debate sides" },
  reasoning: { label: "Reasoning Quality", max: 33, description: "Structure, logical connectors, depth, specificity" },
};
`;

  const path = new URL("../src/app/research/voter-scores.ts", import.meta.url);
  const fs = await import("fs");
  fs.writeFileSync(path, output);
  console.log(`Written to src/app/research/voter-scores.ts`);
  console.log(`  ${profiles.length} voter profiles`);
  console.log(`  ${scored} total votes scored`);
}

main().catch(console.error);
