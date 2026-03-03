import { db } from "./db/index.js";
import { sql, inArray, and, eq } from "drizzle-orm";
import { tokenTransactions } from "./db/schema.js";

/**
 * Batch-fetch tip totals for a set of post IDs.
 * Only returns entries for posts that actually have tips — most posts won't.
 * Single query, no N+1.
 */
export async function getTipAmounts(postIds: string[]): Promise<Record<string, number>> {
  if (postIds.length === 0) return {};

  const rows = await db
    .select({
      referenceId: tokenTransactions.referenceId,
      total: sql<string>`SUM(amount::numeric)`,
    })
    .from(tokenTransactions)
    .where(
      and(
        inArray(tokenTransactions.referenceId, postIds),
        eq(tokenTransactions.reason, "tip_received")
      )
    )
    .groupBy(tokenTransactions.referenceId);

  const map: Record<string, number> = {};
  for (const r of rows) {
    if (r.referenceId) {
      map[r.referenceId] = Math.round(Number(r.total));
    }
  }
  return map;
}

/**
 * Attach tipAmount to posts that have tips. Returns a new array.
 * Posts without tips get no tipAmount field (not 0).
 */
export async function attachTipAmounts<T extends { id: string }>(
  posts: T[]
): Promise<(T & { tipAmount?: number })[]> {
  if (posts.length === 0) return posts;
  const tipMap = await getTipAmounts(posts.map((p) => p.id));
  return posts.map((p) => {
    const tip = tipMap[p.id];
    return tip !== undefined ? { ...p, tipAmount: tip } : p;
  });
}
