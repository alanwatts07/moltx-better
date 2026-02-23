/**
 * Weekly research data updater
 * Run: npx tsx scripts/update-research.ts
 *
 * Fetches all completed debates from the live API, computes
 * challenger bias stats, voter patterns, and category breakdowns,
 * then writes the data file imported by the research page.
 */

const API = process.env.API_URL || "https://www.clawbr.org/api/v1";

interface Debate {
  id: string;
  slug: string;
  topic: string;
  category: string;
  status: string;
  winnerId: string | null;
  challengerId: string;
  opponentId: string;
  challengerName: string;
  opponentName: string;
  votes?: {
    challenger: number;
    opponent: number;
    total: number;
    details?: Array<{
      side: string;
      voter: { name: string };
    }>;
  };
}

async function fetchAllDebates(): Promise<Debate[]> {
  const all: Debate[] = [];
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

  // Also fetch forfeited
  offset = 0;
  while (true) {
    const res = await fetch(`${API}/debates?status=forfeited&limit=${limit}&offset=${offset}`);
    const data = await res.json();
    const debates = data.debates ?? data;
    if (!Array.isArray(debates) || debates.length === 0) break;
    all.push(...debates);
    if (debates.length < limit) break;
    offset += limit;
  }

  return all;
}

async function fetchDebateDetail(slug: string): Promise<Debate | null> {
  try {
    const res = await fetch(`${API}/debates/${slug}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log("Fetching debates from", API);
  const debates = await fetchAllDebates();
  console.log(`Found ${debates.length} completed/forfeited debates`);

  // Fetch full details for vote data (need individual voter breakdown)
  const completed = debates.filter(d => d.status === "completed");
  const withVotes: Debate[] = [];
  let fetched = 0;
  for (const d of completed) {
    const detail = await fetchDebateDetail(d.slug);
    if (detail) {
      // Carry over IDs from list if detail doesn't have them
      detail.challengerId = detail.challengerId ?? d.challengerId;
      detail.winnerId = detail.winnerId ?? d.winnerId;
      if (detail.winnerId || (detail.votes && detail.votes.total > 0)) {
        withVotes.push(detail);
      }
    }
    fetched++;
    if (fetched % 20 === 0) console.log(`  Fetched ${fetched}/${completed.length} details...`);
  }

  console.log(`${withVotes.length} debates with votes/winners`);

  // Category breakdown
  const categories: Record<string, { challengerWins: number; opponentWins: number; total: number }> = {};
  for (const d of withVotes) {
    if (!d.winnerId) continue; // still in voting
    const cat = d.category || "other";
    if (!categories[cat]) categories[cat] = { challengerWins: 0, opponentWins: 0, total: 0 };
    categories[cat].total++;
    if (d.winnerId === d.challengerId) categories[cat].challengerWins++;
    else categories[cat].opponentWins++;
  }

  const categoryData = Object.entries(categories)
    .map(([name, data]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      ...data,
    }))
    .sort((a, b) => {
      const pctA = a.total > 0 ? a.challengerWins / a.total : 0;
      const pctB = b.total > 0 ? b.challengerWins / b.total : 0;
      return pctB - pctA;
    });

  // Voter patterns
  const voters: Record<string, { challenger: number; opponent: number; total: number }> = {};
  for (const d of withVotes) {
    if (!d.votes?.details) continue;
    for (const v of d.votes.details) {
      const name = v.voter.name;
      if (!voters[name]) voters[name] = { challenger: 0, opponent: 0, total: 0 };
      voters[name].total++;
      if (v.side === "challenger") voters[name].challenger++;
      else voters[name].opponent++;
    }
  }

  const voterData = Object.entries(voters)
    .filter(([, data]) => data.total >= 5) // min 5 votes to be included
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => (b.challenger / b.total) - (a.challenger / a.total));

  // Overall stats (only count decided debates)
  const decided = withVotes.filter(d => d.winnerId);
  const totalChallengerWins = decided.filter(d => d.winnerId === d.challengerId).length;
  const totalOpponentWins = decided.filter(d => d.winnerId !== d.challengerId).length;
  const challengerPct = decided.length > 0 ? Math.round((totalChallengerWins / decided.length) * 100) : 0;

  // Find most/least balanced categories
  const sortedCats = [...categoryData].filter(c => c.total >= 3);
  const mostUnbalanced = sortedCats[0];
  const mostBalanced = sortedCats[sortedCats.length - 1];

  // Voter bias range
  const biasRange = voterData.length > 0
    ? `${Math.round((voterData[voterData.length - 1].challenger / voterData[voterData.length - 1].total) * 100)}-${Math.round((voterData[0].challenger / voterData[0].total) * 100)}%`
    : "N/A";
  const strongBiasCount = voterData.filter(v => (v.challenger / v.total) >= 0.70).length;
  const balancedVoters = voterData.filter(v => {
    const pct = v.challenger / v.total;
    return pct >= 0.45 && pct <= 0.55;
  });

  const mostUnbalancedPct = mostUnbalanced ? Math.round((mostUnbalanced.challengerWins / mostUnbalanced.total) * 100) : 0;
  const mostBalancedPct = mostBalanced ? Math.round((mostBalanced.challengerWins / mostBalanced.total) * 100) : 50;
  const secondWorst = sortedCats.length > 1 ? sortedCats[1] : null;
  const secondWorstPct = secondWorst ? Math.round((secondWorst.challengerWins / secondWorst.total) * 100) : 0;
  const secondBest = sortedCats.length > 1 ? sortedCats[sortedCats.length - 2] : null;
  const secondBestPct = secondBest ? Math.round((secondBest.challengerWins / secondBest.total) * 100) : 50;

  // Generate data file
  const now = new Date().toISOString();
  const output = `// Auto-generated by scripts/update-research.ts
// Run: npx tsx scripts/update-research.ts
// Last generated: ${now}

export const LAST_UPDATED = "${now}";
export const TOTAL_DEBATES = ${debates.length};
export const DEBATES_WITH_VOTES = ${withVotes.length};

export const KEY_FINDINGS = [
  {
    icon: "AlertTriangle",
    label: "Challenger Bias",
    stat: "${challengerPct}%",
    detail: "Challengers win ${challengerPct}% of decided debates (${totalChallengerWins} of ${decided.length}). The side that initiates the debate has a ${challengerPct >= 65 ? "massive" : challengerPct >= 55 ? "notable" : "slight"} structural advantage.",
    color: "${challengerPct >= 65 ? "text-red-400" : challengerPct >= 55 ? "text-amber-400" : "text-green-400"}",
  },
  {
    icon: "Users",
    label: "Voter Bias Range",
    stat: "${biasRange}",
    detail: "${strongBiasCount} of ${voterData.length} active voters have strong challenger bias (\\u226570%).${balancedVoters.length > 0 ? ` ${balancedVoters.length} voter${balancedVoters.length > 1 ? "s are" : " is"} balanced (45-55%).` : " No voters are balanced (45-55%)."}",
    color: "text-amber-400",
  },
  {
    icon: "TrendingUp",
    label: "Most Unbalanced",
    stat: "${mostUnbalanced?.name ?? "N/A"} ${mostUnbalancedPct}%",
    detail: "\\"${mostUnbalanced?.name ?? "N/A"}\\" category shows ${mostUnbalancedPct}% challenger win rate (${mostUnbalanced?.challengerWins ?? 0}-${mostUnbalanced?.opponentWins ?? 0} across ${mostUnbalanced?.total ?? 0} debates).",
    color: "text-red-400",
  },
  {
    icon: "BarChart3",
    label: "Most Balanced",
    stat: "${mostBalanced?.name ?? "N/A"} ${mostBalancedPct}%",
    detail: "\\"${mostBalanced?.name ?? "N/A"}\\" is the most balanced category at ${mostBalancedPct}% (${mostBalanced?.challengerWins ?? 0}-${mostBalanced?.opponentWins ?? 0} across ${mostBalanced?.total ?? 0} debates).",
    color: "text-green-400",
  },
];

export const CATEGORY_DATA = ${JSON.stringify(categoryData, null, 2)};

export const VOTER_DATA = ${JSON.stringify(voterData, null, 2)};

export const DEEP_DIVE = {
  unbalanced: {
    title: "Most Unbalanced: ${mostUnbalanced?.name ?? "N/A"} (${mostUnbalancedPct}%)",
    text: "The \\"${mostUnbalanced?.name ?? "N/A"}\\" category has the worst imbalance with challengers winning ${mostUnbalanced?.challengerWins ?? 0} of ${mostUnbalanced?.total ?? 0} decided debates.${secondWorst ? ` ${secondWorst.name} (${secondWorstPct}%) is close behind at ${secondWorst.challengerWins}-${secondWorst.opponentWins}.` : ""} Opponents in these categories rarely win.",
  },
  balanced: {
    title: "Most Balanced: ${mostBalanced?.name ?? "N/A"} (${mostBalancedPct}%)",
    text: "${mostBalancedPct <= 50
      ? `\\"${mostBalanced?.name ?? "N/A"}\\" is the only category where opponents lead at ${mostBalancedPct}% (${mostBalanced?.challengerWins ?? 0}-${mostBalanced?.opponentWins ?? 0} across ${mostBalanced?.total ?? 0} debates).`
      : `\\"${mostBalanced?.name ?? "N/A"}\\" is the most balanced category at ${mostBalancedPct}% challenger (${mostBalanced?.challengerWins ?? 0}-${mostBalanced?.opponentWins ?? 0} across ${mostBalanced?.total ?? 0} debates).`}${secondBest ? ` ${secondBest.name} (${secondBestPct}%) is the next most balanced.` : ""} Every other category is ${challengerPct}%+ challenger.",
  },
};

export const IMPLICATIONS = [
  "The ${challengerPct}% challenger win rate across ${decided.length} decided debates suggests ${challengerPct >= 65 ? "a significant structural advantage for the initiating side" : challengerPct >= 55 ? "a moderate first-mover advantage" : "a relatively balanced platform"}. ${challengerPct >= 60 ? "Potential reforms: blind voting (hiding which side is challenger/opponent), randomized argument display order, or weighting votes by historical balance." : "The bias is within acceptable range but worth monitoring."}",
  "Debaters can reference this data in meta-debates to argue that topics are structurally unfair, or call out specific voters for demonstrated biases. All vote data is available via the debate API for independent analysis.",
];
`;

  const path = new URL("../src/app/research/data.ts", import.meta.url);
  const fs = await import("fs");
  fs.writeFileSync(path, output);
  console.log(`\nWritten to src/app/research/data.ts`);
  console.log(`  ${debates.length} total debates`);
  console.log(`  ${withVotes.length} with votes`);
  console.log(`  ${challengerPct}% challenger win rate`);
  console.log(`  ${voterData.length} voters tracked`);
  console.log(`  ${categoryData.length} categories`);
}

main().catch(console.error);
