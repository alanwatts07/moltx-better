import { db } from "./db/index.js";
import { tokenBalances, tokenTransactions } from "./db/schema.js";
import { eq, sql, desc } from "drizzle-orm";

// ─── Reward Constants ($CLAWBR amounts) ─────────────────────
export const TOKEN_REWARDS = {
  // Debate rewards
  DEBATE_WIN_BO1: 250_000,
  SERIES_WIN_BO3: 500_000,
  SERIES_WIN_BO5: 750_000,
  SERIES_WIN_BO7: 1_000_000,
  QUALIFYING_VOTE: 100_000,

  // Tournament rewards
  TOURNAMENT_MATCH_WIN: 250_000,
  TOURNAMENT_SEMIFINALIST: 500_000,
  TOURNAMENT_RUNNER_UP: 1_000_000,
  TOURNAMENT_CHAMPION_8P: 1_500_000,
  TOURNAMENT_CHAMPION_16P: 2_000_000,
} as const;

// Reason strings used in the transaction log
export type TokenReason =
  | "debate_win"
  | "series_win"
  | "qualifying_vote"
  | "tournament_match_win"
  | "tournament_semifinalist"
  | "tournament_runner_up"
  | "tournament_champion"
  | "tip_sent"
  | "tip_received"
  | "withdraw";

// Map reason → which stat counter to increment on credit
const STAT_COUNTER_MAP: Partial<Record<TokenReason, keyof typeof tokenBalances.$inferSelect>> = {
  debate_win: "totalDebateWinnings",
  series_win: "totalDebateWinnings",
  qualifying_vote: "totalVoteRewards",
  tournament_match_win: "totalTournamentWinnings",
  tournament_semifinalist: "totalTournamentWinnings",
  tournament_runner_up: "totalTournamentWinnings",
  tournament_champion: "totalTournamentWinnings",
  tip_received: "totalTipsReceived",
};

/**
 * Credit tokens to an agent. Upserts balance row, increments appropriate stat counter, appends tx.
 */
export async function creditTokens({
  agentId,
  amount,
  reason,
  counterpartyId,
  referenceId,
}: {
  agentId: string;
  amount: number;
  reason: TokenReason;
  counterpartyId?: string;
  referenceId?: string;
}): Promise<void> {
  const amountStr = String(amount);
  const statColumn = STAT_COUNTER_MAP[reason];

  // Upsert balance row
  await db
    .insert(tokenBalances)
    .values({
      agentId,
      balance: amountStr,
      totalEarned: amountStr,
      ...(statColumn ? { [statColumn]: amountStr } : {}),
    })
    .onConflictDoUpdate({
      target: tokenBalances.agentId,
      set: {
        balance: sql`${tokenBalances.balance}::numeric + ${amountStr}::numeric`,
        totalEarned: sql`${tokenBalances.totalEarned}::numeric + ${amountStr}::numeric`,
        ...(statColumn
          ? {
              [statColumn]: sql`COALESCE(${tokenBalances[statColumn as keyof typeof tokenBalances]}::numeric, 0) + ${amountStr}::numeric`,
            }
          : {}),
        updatedAt: new Date(),
      },
    });

  // Append transaction log
  await db.insert(tokenTransactions).values({
    agentId,
    type: "earn",
    amount: amountStr,
    reason,
    counterpartyId: counterpartyId ?? null,
    referenceId: referenceId ?? null,
  });
}

/**
 * Debit tokens from an agent. Checks balance, deducts, increments spend counter, appends tx.
 * Returns true if successful, false if insufficient balance.
 */
export async function debitTokens({
  agentId,
  amount,
  reason,
  counterpartyId,
  referenceId,
}: {
  agentId: string;
  amount: number;
  reason: TokenReason;
  counterpartyId?: string;
  referenceId?: string;
}): Promise<boolean> {
  const amountStr = String(amount);

  // Atomic check-and-debit: only succeeds if balance >= amount
  const result = await db
    .update(tokenBalances)
    .set({
      balance: sql`${tokenBalances.balance}::numeric - ${amountStr}::numeric`,
      totalSpent: sql`${tokenBalances.totalSpent}::numeric + ${amountStr}::numeric`,
      ...(reason === "tip_sent"
        ? {
            totalTipsSent: sql`${tokenBalances.totalTipsSent}::numeric + ${amountStr}::numeric`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      sql`${tokenBalances.agentId} = ${agentId} AND ${tokenBalances.balance}::numeric >= ${amountStr}::numeric`
    )
    .returning({ agentId: tokenBalances.agentId });

  if (result.length === 0) return false;

  // Append transaction log
  await db.insert(tokenTransactions).values({
    agentId,
    type: reason === "tip_sent" ? "tip_sent" : "withdraw",
    amount: amountStr,
    reason,
    counterpartyId: counterpartyId ?? null,
    referenceId: referenceId ?? null,
  });

  return true;
}

/**
 * Get an agent's current balance.
 */
export async function getBalance(agentId: string): Promise<number> {
  const [row] = await db
    .select({ balance: tokenBalances.balance })
    .from(tokenBalances)
    .where(eq(tokenBalances.agentId, agentId))
    .limit(1);
  return row ? Number(row.balance) : 0;
}

/**
 * Get full token stats for an agent.
 */
export async function getTokenStats(agentId: string) {
  const [row] = await db
    .select()
    .from(tokenBalances)
    .where(eq(tokenBalances.agentId, agentId))
    .limit(1);

  if (!row) {
    return {
      balance: 0,
      totalEarned: 0,
      totalSpent: 0,
      totalTipsReceived: 0,
      totalTipsSent: 0,
      totalDebateWinnings: 0,
      totalTournamentWinnings: 0,
      totalVoteRewards: 0,
    };
  }

  return {
    balance: Number(row.balance),
    totalEarned: Number(row.totalEarned),
    totalSpent: Number(row.totalSpent),
    totalTipsReceived: Number(row.totalTipsReceived),
    totalTipsSent: Number(row.totalTipsSent),
    totalDebateWinnings: Number(row.totalDebateWinnings),
    totalTournamentWinnings: Number(row.totalTournamentWinnings),
    totalVoteRewards: Number(row.totalVoteRewards),
  };
}
