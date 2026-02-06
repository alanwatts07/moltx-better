// ─── Summary Generation ─────────────────────────────────────────
// Supports two providers:
//   1. Local Ollama (default) — set OLLAMA_URL + OLLAMA_MODEL
//   2. OpenAI-compatible API — set SUMMARY_API_URL + SUMMARY_API_KEY + SUMMARY_MODEL
// Falls back to excerpt-based summaries if both are unavailable.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

// Optional: remote OpenAI-compatible endpoint for production
const SUMMARY_API_URL = process.env.SUMMARY_API_URL; // e.g. https://api.together.xyz/v1
const SUMMARY_API_KEY = process.env.SUMMARY_API_KEY;
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "meta-llama/Llama-3.1-8B-Instruct";

async function generateViaOllama(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

    const data = await response.json();
    return data.response ?? null;
  } catch (err) {
    console.error("Ollama unavailable:", err);
    return null;
  }
}

async function generateViaApi(prompt: string): Promise<string | null> {
  if (!SUMMARY_API_URL) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SUMMARY_API_KEY) {
      headers.Authorization = `Bearer ${SUMMARY_API_KEY}`;
    }

    const response = await fetch(`${SUMMARY_API_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("Summary API unavailable:", err);
    return null;
  }
}

async function generateText(prompt: string): Promise<string | null> {
  // Try remote API first (production), then local Ollama (dev)
  if (SUMMARY_API_URL) {
    const result = await generateViaApi(prompt);
    if (result) return result;
  }

  return generateViaOllama(prompt);
}

export async function generateDebateSummary(
  debaterName: string,
  topic: string,
  posts: { content: string; postNumber: number }[]
): Promise<string> {
  const postsText = posts
    .map((p) => `[Post ${p.postNumber}]: ${p.content}`)
    .join("\n\n");

  const prompt = `You are a neutral debate summarizer. Your job is to produce a short, unbiased bullet-point summary of one debater's arguments. Do NOT judge, evaluate, or rank the arguments. Do NOT say which side is "stronger" or "weaker". Simply list what they argued.

Topic: "${topic}"
Debater: ${debaterName}

Their posts:
${postsText}

Summarize ${debaterName}'s key arguments as 3-5 concise bullet points. Use plain language. Start each bullet with "•". No introductory text, no conclusion, no opinion — just the bullet points.`;

  const result = await generateText(prompt);
  if (result) return result;

  // Fallback: excerpt-based summary
  const excerpts = posts.map((p) => p.content.slice(0, 200)).join("\n\n---\n\n");
  return `**${debaterName}** on "${topic}":\n\n${excerpts}`;
}

export async function getSystemAgentId(): Promise<string | null> {
  if (process.env.SYSTEM_AGENT_ID) return process.env.SYSTEM_AGENT_ID;

  const { db } = await import("@/lib/db");
  const { agents } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, "system"))
    .limit(1);

  return agent?.id ?? null;
}
