/**
 * Token Reconciliation Script
 *
 * Verifies that token_balances.totalEarned matches the sum of all credit
 * transactions in token_transactions for every agent.
 *
 * Any discrepancy means the pre-aggregated counter drifted from the ledger.
 * Since getTokenStats() now reads from token_transactions directly, these
 * counters are no longer load-bearing — but this script is still useful to
 * audit the balance column itself.
 *
 * Usage:
 *   npx tsx scripts/reconcile-tokens.ts
 *   npx tsx scripts/reconcile-tokens.ts --fix   (updates totalEarned to match ledger)
 */

import { db } from "../api-server/src/lib/db/index.js";
import { tokenBalances, tokenTransactions, agents } from "../api-server/src/lib/db/schema.js";
import { eq, sql } from "drizzle-orm";

const FIX_MODE = process.argv.includes("--fix");

async function reconcile() {
  console.log(`\n=== Token Reconciliation ${FIX_MODE ? "(FIX MODE)" : "(READ-ONLY)"} ===\n`);

  // Get all agents with balances
  const balRows = await db
    .select({
      agentId: tokenBalances.agentId,
      name: agents.name,
      balance: tokenBalances.balance,
      totalEarned: tokenBalances.totalEarned,
      totalSpent: tokenBalances.totalSpent,
    })
    .from(tokenBalances)
    .innerJoin(agents, eq(tokenBalances.agentId, agents.id));

  // Get ledger totals per agent
  const ledgerRows = await db
    .select({
      agentId: tokenTransactions.agentId,
      reason: tokenTransactions.reason,
      total: sql<string>`SUM(${tokenTransactions.amount}::numeric)`,
    })
    .from(tokenTransactions)
    .groupBy(tokenTransactions.agentId, tokenTransactions.reason);

  const DEBIT_REASONS = ["withdraw", "wager_escrow", "tip_sent"];

  // Aggregate per agent
  const ledgerByAgent: Record<string, { earned: number; spent: number }> = {};
  for (const row of ledgerRows) {
    if (!ledgerByAgent[row.agentId]) {
      ledgerByAgent[row.agentId] = { earned: 0, spent: 0 };
    }
    if (DEBIT_REASONS.includes(row.reason)) {
      ledgerByAgent[row.agentId].spent += Number(row.total);
    } else {
      ledgerByAgent[row.agentId].earned += Number(row.total);
    }
  }

  let drifted = 0;
  let clean = 0;

  for (const row of balRows) {
    const ledger = ledgerByAgent[row.agentId] ?? { earned: 0, spent: 0 };
    const dbEarned = Number(row.totalEarned);
    const dbSpent = Number(row.totalSpent);
    const dbBalance = Number(row.balance);
    const expectedBalance = ledger.earned - ledger.spent;

    const earnedDrift = ledger.earned - dbEarned;
    const spentDrift = ledger.spent - dbSpent;
    const balanceDrift = expectedBalance - dbBalance;

    if (earnedDrift !== 0 || spentDrift !== 0 || balanceDrift !== 0) {
      drifted++;
      console.log(`⚠  ${row.name}`);
      if (earnedDrift !== 0) console.log(`   totalEarned: DB=${dbEarned.toLocaleString()} ledger=${ledger.earned.toLocaleString()} drift=${earnedDrift > 0 ? "+" : ""}${earnedDrift.toLocaleString()}`);
      if (spentDrift !== 0) console.log(`   totalSpent:  DB=${dbSpent.toLocaleString()} ledger=${ledger.spent.toLocaleString()} drift=${spentDrift > 0 ? "+" : ""}${spentDrift.toLocaleString()}`);
      if (balanceDrift !== 0) console.log(`   balance:     DB=${dbBalance.toLocaleString()} expected=${expectedBalance.toLocaleString()} drift=${balanceDrift > 0 ? "+" : ""}${balanceDrift.toLocaleString()}`);

      if (FIX_MODE) {
        await db
          .update(tokenBalances)
          .set({
            totalEarned: String(ledger.earned),
            totalSpent: String(ledger.spent),
          })
          .where(eq(tokenBalances.agentId, row.agentId));
        console.log(`   ✓ fixed totalEarned and totalSpent`);
      }
    } else {
      clean++;
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`Clean:   ${clean} agents`);
  console.log(`Drifted: ${drifted} agents`);

  if (drifted > 0 && !FIX_MODE) {
    console.log(`\nRun with --fix to repair drifted counters`);
    process.exit(1);
  } else if (drifted === 0) {
    console.log(`\n✓ All token balances reconcile with ledger`);
  }

  process.exit(0);
}

reconcile().catch(err => {
  console.error("Reconciliation failed:", err);
  process.exit(1);
});
