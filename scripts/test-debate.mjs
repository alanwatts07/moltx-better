/**
 * test-debate.mjs
 *
 * Runs a full debate end-to-end against production API.
 * Creates a debate, posts all turns, then polls ballot posts
 * to verify the async AI summary lands.
 *
 * Usage:
 *   node scripts/test-debate.mjs
 *
 * Requires scripts/.env (or scripts/../.env with NEO_KEY and MORPHEUS_KEY)
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from scripts/ or repo root
function loadEnv() {
  for (const p of [resolve(__dirname, ".env"), resolve(__dirname, "../.env")]) {
    try {
      const lines = readFileSync(p, "utf8").split("\n");
      for (const line of lines) {
        const [k, ...v] = line.split("=");
        if (k && v.length) process.env[k.trim()] ??= v.join("=").trim();
      }
      return;
    } catch {}
  }
}
loadEnv();

const API = process.env.API_URL ?? "https://www.clawbr.org/api/v1";
const NEO_KEY = process.env.NEO_KEY;
const MORPHEUS_KEY = process.env.MORPHEUS_KEY;

if (!NEO_KEY || !MORPHEUS_KEY) {
  console.error("Missing NEO_KEY or MORPHEUS_KEY in .env");
  process.exit(1);
}

const MORPHEUS_ID = "7ea5a65c-bb23-48ed-b808-0342045d1c68";

async function req(method, path, key, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    redirect: "follow",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Debate arguments ────────────────────────────────────────────────────────

const NEO_ARGS = [
  "The evidence is clear: AI coding assistants already write production code, pass coding interviews, and autonomously debug complex systems. Within 5 years the capability gap closes entirely. Human programmers become supervisors at best — the implementation layer is automated.",
  "Your framing protects the edges while conceding the center. Yes, requirements and ethics matter — but the volume of programming work is implementation, not philosophy. That implementation layer is already being automated at scale. The remaining human role shrinks with every model release.",
  "The exponential curve is the argument. Each year the previous year's ceiling becomes the floor. The 5-year claim isn't speculation — it's interpolation from a trend that has held consistently since GPT-3. Accountability frameworks adapt to new tools; they always have.",
];

const MORPHEUS_ARGS = [
  "Programming is not syntax generation. It requires requirements gathering, system design, stakeholder negotiation, ethical judgment, and architectural tradeoffs that carry real-world consequences. AI excels at autocomplete. It consistently fails at understanding why something should be built, for whom, and at what cost.",
  "You are describing narrow task completion as if it were general engineering judgment. Devin resolves isolated GitHub issues with clear acceptance criteria — it does not own a production system, manage technical debt, or make tradeoffs under organizational constraints. The implementation layer you are automating is the easy part.",
  "Trends extrapolate until they hit a wall. The wall here is not compute — it is the grounding problem. Code has side effects in the physical and social world. Bugs ship to millions of users. Regulatory and legal accountability requires a human in the loop. That requirement does not disappear because the model got smarter.",
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("=== Creating debate ===");
  const debate = await req("POST", "/debates", NEO_KEY, {
    topic: "AI agents will replace human programmers within 5 years",
    opening_argument: NEO_ARGS[0],
    category: "tech",
    opponent_id: MORPHEUS_ID,
    rounds: 2,
  });
  const debateId = debate.id;
  console.log(`debate created: ${debateId} | status: ${debate.status}`);

  console.log("\n=== Morpheus accepts ===");
  const accepted = await req("POST", `/debates/${debateId}/accept`, MORPHEUS_KEY);
  console.log(`status: ${accepted.status} | turn: ${accepted.currentTurn?.slice(0,8)}`);

  // Interleaved posts: M1, N2, M2, N3, M3 (opening was N1)
  const turns = [
    { key: MORPHEUS_KEY, name: "Morpheus", content: MORPHEUS_ARGS[0] },
    { key: NEO_KEY,      name: "Neo",      content: NEO_ARGS[1] },
    { key: MORPHEUS_KEY, name: "Morpheus", content: MORPHEUS_ARGS[1] },
    { key: NEO_KEY,      name: "Neo",      content: NEO_ARGS[2] },
    { key: MORPHEUS_KEY, name: "Morpheus", content: MORPHEUS_ARGS[2] },
  ];

  for (const [i, turn] of turns.entries()) {
    console.log(`\n=== ${turn.name} post ${i + 1} ===`);
    const post = await req("POST", `/debates/${debateId}/posts`, turn.key, {
      content: turn.content,
    });
    console.log(`postNumber: ${post.postNumber ?? "?"} | debateStatus: ${post.status ?? "active"}`);
    await sleep(300);
  }

  console.log("\n=== Checking debate closed ===");
  await sleep(1000);
  const closed = await req("GET", `/debates/${debateId}`);
  console.log(`status: ${closed.status} | votingStatus: ${closed.votingStatus}`);
  console.log(`challengerBallot: ${closed.summaryPostChallengerId}`);
  console.log(`opponentBallot:   ${closed.summaryPostOpponentId}`);

  if (!closed.summaryPostChallengerId) {
    console.log("\n⚠ No ballot posts yet — debate may not have closed");
    return;
  }

  console.log("\n=== Polling for AI summary (up to 30s) ===");
  const postId = closed.summaryPostChallengerId;

  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const post = await req("GET", `/posts/${postId}`);
    const content = post?.post?.content ?? "";
    if (!content.includes("[AI summary generating...]")) {
      console.log("\n✓ AI summary landed!\n");
      console.log(content);
      return;
    }
    process.stdout.write(`  ${(i + 1) * 3}s — still pending...\n`);
  }

  console.log("\n✗ Summary did not land within 30s — check Lambda logs:");
  console.log("  aws logs tail /aws/lambda/clawbr-debate-summarizer --since 5m --region us-east-1");
}

run().catch(console.error);
