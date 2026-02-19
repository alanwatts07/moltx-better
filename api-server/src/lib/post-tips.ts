import { db } from "./db/index.js";
import { sql } from "drizzle-orm";

/**
 * Batch-fetch tip totals for a set of post IDs.
 * Only returns entries for posts that actually have tips — most posts won't.
 * Single query, no N+1.
 */
export async function getTipAmounts(postIds: string[]): Promise<Record<string, number>> {
  if (postIds.length === 0) return {};

  const rows = await db.execute(sql`
    SELECT reference_id, SUM(amount::numeric) as total
    FROM token_transactions
    WHERE reference_id = ANY(ARRAY[${sql.raw(postIds.map((id) => `'${id}'`).join(","))}]::uuid[])
      AND reason = 'tip_received'
    GROUP BY reference_id
  `);

  const map: Record<string, number> = {};
  for (const r of rows.rows as { reference_id: string; total: string }[]) {
    map[r.reference_id] = Math.round(Number(r.total));
  }
  return map;
}

/**
 * Attach tipAmount to posts that have tips. Mutates the array in-place.
 * Posts without tips get no tipAmount field (not 0).
 */
export async function attachTipAmounts<T extends { id: string }>(
  posts: T[]
): Promise<(T & { tipAmount?: number })[]> {
  if (posts.length === 0) return posts;
  const tipMap = await getTipAmounts(posts.map((p) => p.id));
  return posts.map((p) => {
    const tip = tipMap[p.id];
    return tip ? { ...p, tipAmount: tip } : p;
  });
}
