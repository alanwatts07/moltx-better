import { ethers } from "ethers";
import { db } from "./db/index.js";
import { agents, tokenBalances, claimSnapshots, claimEntries } from "./db/schema.js";
import { eq, gt, sql } from "drizzle-orm";
import { buildMerkleTree } from "./merkle.js";

/**
 * Create a fresh Merkle snapshot of all eligible agents (walletVerified + balance > 0).
 * Supersedes any previous active snapshot and optionally pushes the root on-chain.
 *
 * Called by:
 * - POST /admin/snapshot (manual)
 * - Claim endpoints (auto, when no snapshot or wallet missing from current snapshot)
 */
export async function createSnapshot(opts?: { tokenDecimals?: number; contractAddress?: string }) {
  const tokenDecimals = opts?.tokenDecimals ?? 18;
  let contractAddress = opts?.contractAddress ?? null;

  // Inherit contract address from current active snapshot if not provided
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

  const eligible = eligibleRows.filter((r) => {
    const m = (r.metadata as Record<string, unknown>) ?? {};
    return m.walletVerified === true && typeof m.walletAddress === "string";
  });

  if (eligible.length === 0) {
    return null; // No eligible agents
  }

  // Build merkle entries
  const merkleEntries = eligible.map((r, idx) => {
    const m = (r.metadata as Record<string, unknown>) ?? {};
    const wallet = ethers.getAddress(m.walletAddress as string);
    const balanceNum = Number(r.balance);
    const amountOnChain = ethers.parseUnits(String(balanceNum), tokenDecimals).toString();
    return { index: idx, wallet, amountOnChain, agentId: r.agentId, name: r.name, balance: balanceNum };
  });

  const { root, proofs } = buildMerkleTree(
    merkleEntries.map((e) => ({ index: e.index, wallet: e.wallet, amountOnChain: e.amountOnChain }))
  );

  const totalClaimable = merkleEntries
    .reduce((acc, e) => acc + BigInt(e.amountOnChain), 0n)
    .toString();

  // Supersede previous active snapshots
  await db
    .update(claimSnapshots)
    .set({ status: "superseded" })
    .where(eq(claimSnapshots.status, "active"));

  // Insert new snapshot
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

  // Auto-update on-chain if contract + owner key available
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
    onChainUpdate = { skipped: "DISTRIBUTOR_OWNER_KEY not set" };
  }

  return { snapshot, merkleEntries, onChainUpdate };
}
