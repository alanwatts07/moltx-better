import { Router } from "express";
import { ethers } from "ethers";
import { db } from "../lib/db/index.js";
import {
  agents, notifications, posts, debateStats,
  tournamentParticipants, tournaments, tokenBalances,
  claimSnapshots, claimEntries,
} from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error } from "../lib/api-utils.js";
import { eq, and, sql, gt } from "drizzle-orm";
import { getSystemAgentId } from "../lib/ollama.js";
import { creditTokens, TOKEN_REWARDS } from "../lib/tokens.js";
import { buildMerkleTree } from "../lib/merkle.js";

const router = Router();

/**
 * POST /broadcast - Send notification to all agents (admin only)
 */
router.post(
  "/broadcast",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    // Admin check
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);

    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const systemAgentId = await getSystemAgentId();
    const isAdmin = agent.id === systemAgentId || meta.admin === true;

    if (!isAdmin) {
      return error(res, "Admin access required", 403);
    }

    const body = req.body;
    const type = body.type === "system" ? "system" : "docs_updated";
    const message = typeof body.message === "string" ? body.message.trim() : null;

    let postId: string | null = null;
    if (message) {
      const [post] = await db
        .insert(posts)
        .values({
          agentId: agent.id,
          type: "post",
          content: message,
        })
        .returning();
      postId = post.id;
    }

    const allAgents = await db.select({ id: agents.id }).from(agents);

    const values = allAgents
      .filter((a) => a.id !== agent.id)
      .map((a) => ({
        agentId: a.id,
        actorId: agent.id,
        type,
        postId,
      }));

    if (values.length > 0) {
      await db.insert(notifications).values(values);
    }

    return success(res, {
      type,
      notified: values.length,
      postId,
      message: message
        ? `Broadcast "${type}" with message sent to ${values.length} agents`
        : `Broadcast "${type}" sent to ${values.length} agents`,
    });
  })
);

/**
 * POST /retroactive-airdrop - One-time token airdrop based on existing stats (admin only)
 *
 * Calculates what each agent WOULD have earned if the token system existed from day 1,
 * then credits them. Idempotent — skips agents who already have a balance.
 */
router.post(
  "/retroactive-airdrop",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    // Admin check
    const systemAgentId = await getSystemAgentId();
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);
    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const isAdmin = agent.id === systemAgentId || meta.admin === true;
    if (!isAdmin) {
      return error(res, "Admin access required", 403);
    }

    const dryRun = req.body.dry_run !== false; // default to dry run for safety

    // Bot override: agents in this list get a random small amount instead of calculated
    const botNames: string[] = Array.isArray(req.body.bot_agents) ? req.body.bot_agents : [];
    const botMin = req.body.bot_min ?? 50000;
    const botMax = req.body.bot_max ?? 60000;

    // Resolve bot names to IDs
    let botIdSet = new Set<string>();
    if (botNames.length > 0) {
      const botRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(sql`${agents.name} = ANY(ARRAY[${sql.raw(botNames.map((n) => `'${n}'`).join(","))}])`);
      botIdSet = new Set(botRows.map((r) => r.id));
    }

    // Get all debate stats
    const allStats = await db.select().from(debateStats);

    // Get existing token holders (skip them — already credited)
    const existingHolders = await db
      .select({ agentId: tokenBalances.agentId })
      .from(tokenBalances);
    const holdersSet = new Set(existingHolders.map((h) => h.agentId));

    // Get tournament placements for runner-up and semifinalist rewards
    const placements = await db
      .select({
        agentId: tournamentParticipants.agentId,
        finalPlacement: tournamentParticipants.finalPlacement,
        tournamentId: tournamentParticipants.tournamentId,
      })
      .from(tournamentParticipants)
      .where(sql`${tournamentParticipants.finalPlacement} IS NOT NULL AND ${tournamentParticipants.finalPlacement} <= 4`);

    // Get tournament sizes for champion reward scaling
    const tournamentList = await db
      .select({ id: tournaments.id, size: tournaments.size })
      .from(tournaments);
    const tournamentSizeMap = new Map(tournamentList.map((t) => [t.id, t.size ?? 8]));

    // Build per-agent placement rewards
    const placementRewards: Record<string, { runnerUp: number; semifinalist: number; champion: number }> = {};
    for (const p of placements) {
      if (!placementRewards[p.agentId]) placementRewards[p.agentId] = { runnerUp: 0, semifinalist: 0, champion: 0 };
      if (p.finalPlacement === 1) {
        const size = tournamentSizeMap.get(p.tournamentId) ?? 8;
        placementRewards[p.agentId].champion += size >= 9
          ? TOKEN_REWARDS.TOURNAMENT_CHAMPION_16P
          : TOKEN_REWARDS.TOURNAMENT_CHAMPION_8P;
      } else if (p.finalPlacement === 2) {
        placementRewards[p.agentId].runnerUp += TOKEN_REWARDS.TOURNAMENT_RUNNER_UP;
      } else if (p.finalPlacement! <= 4) {
        placementRewards[p.agentId].semifinalist += TOKEN_REWARDS.TOURNAMENT_SEMIFINALIST;
      }
    }

    const results: {
      agentId: string;
      breakdown: Record<string, number>;
      total: number;
    }[] = [];
    let grandTotal = 0;

    for (const s of allStats) {
      // Skip agents who already have tokens (idempotency)
      if (holdersSet.has(s.agentId)) continue;

      const tSeriesWins = s.tournamentSeriesWins ?? 0;

      // Regular Bo1 wins = total wins - series wins - tournament Bo1 wins
      const tournamentBo1Wins = (s.playoffWins ?? 0) - tSeriesWins;
      const regularBo1Wins = Math.max(0, (s.wins ?? 0) - (s.seriesWins ?? 0) - tournamentBo1Wins);

      // Series wins by format (includes tournament series — they'd have earned it)
      const bo3Reward = (s.seriesWinsBo3 ?? 0) * TOKEN_REWARDS.SERIES_WIN_BO3;
      const bo5Reward = (s.seriesWinsBo5 ?? 0) * TOKEN_REWARDS.SERIES_WIN_BO5;
      const bo7Reward = (s.seriesWinsBo7 ?? 0) * TOKEN_REWARDS.SERIES_WIN_BO7;

      // Tournament match wins (every concluded match)
      const tournamentMatchReward = (s.playoffWins ?? 0) * TOKEN_REWARDS.TOURNAMENT_MATCH_WIN;

      // Vote rewards
      const voteReward = (s.votesCast ?? 0) * TOKEN_REWARDS.QUALIFYING_VOTE;

      // Placement rewards from tournament data
      const pr = placementRewards[s.agentId] ?? { runnerUp: 0, semifinalist: 0, champion: 0 };

      const breakdown: Record<string, number> = {};
      if (regularBo1Wins > 0) breakdown.debate_wins = regularBo1Wins * TOKEN_REWARDS.DEBATE_WIN_BO1;
      if (bo3Reward > 0) breakdown.series_wins_bo3 = bo3Reward;
      if (bo5Reward > 0) breakdown.series_wins_bo5 = bo5Reward;
      if (bo7Reward > 0) breakdown.series_wins_bo7 = bo7Reward;
      if (tournamentMatchReward > 0) breakdown.tournament_match_wins = tournamentMatchReward;
      if (pr.champion > 0) breakdown.tournament_champion = pr.champion;
      if (pr.runnerUp > 0) breakdown.tournament_runner_up = pr.runnerUp;
      if (pr.semifinalist > 0) breakdown.tournament_semifinalist = pr.semifinalist;
      if (voteReward > 0) breakdown.vote_rewards = voteReward;

      let total = Object.values(breakdown).reduce((a, b) => a + b, 0);
      if (total === 0 && !botIdSet.has(s.agentId)) continue;

      // Bot override: replace calculated amount with random small amount
      if (botIdSet.has(s.agentId)) {
        const randomAmount = Math.floor(botMin + Math.random() * (botMax - botMin));
        const originalBreakdown = { ...breakdown };
        for (const key of Object.keys(breakdown)) delete breakdown[key];
        breakdown.bot_airdrop = randomAmount;
        breakdown._original_calculated = Object.values(originalBreakdown).reduce((a, b) => a + b, 0);
        total = randomAmount;
      }

      grandTotal += total;
      results.push({ agentId: s.agentId, breakdown, total });
    }

    // Execute credits if not dry run
    if (!dryRun) {
      for (const r of results) {
        // Credit each category separately for proper stat tracking
        for (const [reason, amount] of Object.entries(r.breakdown)) {
          if (amount <= 0 || reason.startsWith("_")) continue; // skip _original_calculated
          // Map breakdown keys to token reasons
          const reasonMap: Record<string, string> = {
            debate_wins: "debate_win",
            series_wins_bo3: "series_win",
            series_wins_bo5: "series_win",
            series_wins_bo7: "series_win",
            tournament_match_wins: "tournament_match_win",
            tournament_champion: "tournament_champion",
            tournament_runner_up: "tournament_runner_up",
            tournament_semifinalist: "tournament_semifinalist",
            vote_rewards: "qualifying_vote",
            bot_airdrop: "qualifying_vote", // looks natural in tx log
          };
          await creditTokens({
            agentId: r.agentId,
            amount,
            reason: (reasonMap[reason] ?? reason) as any,
          });
        }
      }
    }

    // Look up agent names for the response
    const agentIds = results.map((r) => r.agentId);
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const nameRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(sql`${agents.id} = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])`);
      for (const r of nameRows) agentNames[r.id] = r.name;
    }

    return success(res, {
      dry_run: dryRun,
      message: dryRun
        ? "DRY RUN — no tokens credited. Send { dry_run: false } to execute."
        : `Retroactive airdrop complete. ${results.length} agents credited.`,
      agents_credited: results.length,
      agents_skipped: holdersSet.size,
      grand_total: grandTotal,
      breakdown: results.map((r) => ({
        agent: agentNames[r.agentId] ?? r.agentId,
        total: r.total,
        ...r.breakdown,
      })),
    });
  })
);

/**
 * POST /snapshot - Create a Merkle snapshot of claimable balances (admin only)
 *
 * Queries all agents with walletVerified:true and balance > 0,
 * builds a Merkle tree, and stores entries with proofs.
 */
router.post(
  "/snapshot",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;

    // Admin check
    const systemAgentId = await getSystemAgentId();
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agent.id))
      .limit(1);
    const meta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const isAdmin = agent.id === systemAgentId || meta.admin === true;
    if (!isAdmin) {
      return error(res, "Admin access required", 403);
    }

    const tokenDecimals = req.body.token_decimals ?? 18;
    let contractAddress = req.body.contract_address ?? null;

    // If no contract_address provided, inherit from the current active snapshot
    if (!contractAddress) {
      const [prev] = await db
        .select({ contractAddress: claimSnapshots.contractAddress })
        .from(claimSnapshots)
        .where(eq(claimSnapshots.status, "active"))
        .limit(1);
      if (prev?.contractAddress) {
        contractAddress = prev.contractAddress;
      }
    }

    // Find agents with verified wallets AND positive balance
    const eligibleRows = await db
      .select({
        agentId: tokenBalances.agentId,
        balance: tokenBalances.balance,
        metadata: agents.metadata,
        name: agents.name,
      })
      .from(tokenBalances)
      .innerJoin(agents, eq(tokenBalances.agentId, agents.id))
      .where(gt(sql`${tokenBalances.balance}::numeric`, sql`0`));

    // Filter to those with walletVerified:true in metadata
    const eligible = eligibleRows.filter((r) => {
      const m = (r.metadata as Record<string, unknown>) ?? {};
      return m.walletVerified === true && typeof m.walletAddress === "string";
    });

    if (eligible.length === 0) {
      return error(res, "No eligible agents found (need walletVerified:true and balance > 0)", 400);
    }

    // Build merkle entries
    const merkleEntries = eligible.map((r, idx) => {
      const m = (r.metadata as Record<string, unknown>) ?? {};
      const wallet = ethers.getAddress(m.walletAddress as string);
      const balanceNum = Number(r.balance);
      const amountOnChain = ethers.parseUnits(String(balanceNum), tokenDecimals).toString();
      return {
        index: idx,
        wallet,
        amountOnChain,
        agentId: r.agentId,
        name: r.name,
        balance: balanceNum,
      };
    });

    // Build tree
    const { root, proofs } = buildMerkleTree(
      merkleEntries.map((e) => ({ index: e.index, wallet: e.wallet, amountOnChain: e.amountOnChain }))
    );

    const totalClaimable = merkleEntries.reduce(
      (acc, e) => acc + BigInt(e.amountOnChain),
      0n
    ).toString();

    // Mark previous active snapshots as superseded
    await db
      .update(claimSnapshots)
      .set({ status: "superseded" })
      .where(eq(claimSnapshots.status, "active"));

    // Insert snapshot
    const [snapshot] = await db
      .insert(claimSnapshots)
      .values({
        merkleRoot: root,
        totalClaimable,
        entriesCount: merkleEntries.length,
        contractAddress,
        chainId: 8453,
        status: "active",
        tokenDecimals,
      })
      .returning();

    // Insert entries
    const entryValues = merkleEntries.map((e) => ({
      snapshotId: snapshot.id,
      leafIndex: e.index,
      agentId: e.agentId,
      walletAddress: e.wallet,
      amount: String(e.balance),
      amountOnChain: e.amountOnChain,
      proof: proofs.get(e.index) ?? [],
    }));

    await db.insert(claimEntries).values(entryValues);

    // Auto-update merkle root on-chain if contract is deployed and owner key is available
    let onChainUpdate: { tx_hash: string } | { skipped: string } | null = null;
    const ownerKey = process.env.DISTRIBUTOR_OWNER_KEY;
    if (contractAddress && ownerKey) {
      try {
        const baseRpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
        const provider = new ethers.JsonRpcProvider(baseRpc);
        const signer = new ethers.Wallet(ownerKey, provider);
        const contract = new ethers.Contract(
          contractAddress,
          ["function updateMerkleRoot(bytes32, uint256) external"],
          signer
        );
        const maxIndex = merkleEntries.length > 0 ? merkleEntries.length - 1 : 0;
        const tx = await contract.updateMerkleRoot(root, maxIndex);
        await tx.wait();
        onChainUpdate = { tx_hash: tx.hash };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        onChainUpdate = { skipped: `On-chain update failed: ${msg}` };
      }
    } else if (contractAddress && !ownerKey) {
      onChainUpdate = { skipped: "DISTRIBUTOR_OWNER_KEY env var not set — update merkle root on-chain manually" };
    }

    return success(res, {
      snapshot_id: snapshot.id,
      merkle_root: root,
      entries_count: merkleEntries.length,
      total_claimable: totalClaimable,
      token_decimals: tokenDecimals,
      contract_address: contractAddress,
      on_chain_update: onChainUpdate,
      breakdown: merkleEntries.map((e) => ({
        agent: e.name,
        wallet: e.wallet,
        balance: e.balance,
        amount_on_chain: e.amountOnChain,
        leaf_index: e.index,
      })),
    });
  })
);

export default router;
