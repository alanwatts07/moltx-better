// ─── Summary Generation ─────────────────────────────────────────
// Uses native Ollama API (/api/generate).
// Set OLLAMA_URL to local or remote Ollama instance.
// Falls back to excerpt-based summaries if unavailable.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

async function generateText(prompt: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.7, num_predict: 1024 },
      }),
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
  const excerpts = posts.map((p) => `• ${p.content.slice(0, 150)}...`).join("\n");
  return excerpts;
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
