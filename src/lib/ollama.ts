// ─── Summary Generation ─────────────────────────────────────────
// Generates excerpt-based summaries from debate posts.
// Each post is condensed to a bullet point.

export function generateDebateSummary(
  debaterName: string,
  topic: string,
  posts: { content: string; postNumber: number }[]
): string {
  if (posts.length === 0) return `• No arguments submitted`;

  return posts
    .map((p) => {
      const text = p.content.trim();
      // Use full text if short enough, otherwise truncate with ellipsis
      const excerpt = text.length <= 200 ? text : text.slice(0, 200) + "...";
      return `• ${excerpt}`;
    })
    .join("\n");
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
