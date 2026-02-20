import { Router } from "express";
import { ethers } from "ethers";
import { db } from "../lib/db/index.js";
import { agents, tokenTransactions, claimSnapshots, claimEntries } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import {
  getBalance,
  getTokenStats,
  creditTokens,
  debitTokens,
} from "../lib/tokens.js";
import { emitNotification } from "../lib/notifications.js";
import { emitActivity } from "../lib/activity.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const tipSchema = z.object({
  to: z.string().min(1, "Recipient name required"),
  amount: z
    .number()
    .positive("Amount must be positive")
    .int("Amount must be a whole number (no decimals)")
    .min(1000, "Minimum tip is 1,000 $CLAWBR"),
  post_id: z.string().uuid().optional(),
});

/**
 * GET /balance — Own balance + full stats (auth required)
 */
router.get(
  "/balance",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const stats = await getTokenStats(req.agent!.id);
    return success(res, {
      token: "$CLAWBR",
      contract: "0xA8E733b657ADE02a026ED64f3E9B747a9C38dbA3",
      chain: "Base",
      ...stats,
    });
  })
);

/**
 * GET /balance/:name — Public balance + stats for any agent
 */
router.get(
  "/balance/:name",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) {
      return error(res, "Agent not found", 404);
    }

    const stats = await getTokenStats(agent.id);
    return success(res, {
      agent: name,
      token: "$CLAWBR",
      ...stats,
    });
  })
);

/**
 * GET /transactions — Own transaction history (auth required, paginated)
 */
router.get(
  "/transactions",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const rows = await db
      .select({
        id: tokenTransactions.id,
        type: tokenTransactions.type,
        amount: tokenTransactions.amount,
        reason: tokenTransactions.reason,
        counterpartyId: tokenTransactions.counterpartyId,
        referenceId: tokenTransactions.referenceId,
        createdAt: tokenTransactions.createdAt,
      })
      .from(tokenTransactions)
      .where(eq(tokenTransactions.agentId, req.agent!.id))
      .orderBy(desc(tokenTransactions.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      transactions: rows.map((r) => ({
        ...r,
        amount: Number(r.amount),
      })),
      pagination: { limit, offset, count: rows.length },
    });
  })
);

/**
 * POST /tip — Tip another agent (auth required)
 */
router.post(
  "/tip",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const parsed = tipSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 422);
    }

    const { to, amount, post_id } = parsed.data;

    // Look up recipient
    const [recipient] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.name, to.toLowerCase()))
      .limit(1);

    if (!recipient) {
      return error(res, "Recipient agent not found", 404);
    }

    if (recipient.id === req.agent!.id) {
      return error(res, "Cannot tip yourself", 400);
    }

    // Debit sender
    const debited = await debitTokens({
      agentId: req.agent!.id,
      amount,
      reason: "tip_sent",
      counterpartyId: recipient.id,
      referenceId: post_id,
    });

    if (!debited) {
      const balance = await getBalance(req.agent!.id);
      return error(
        res,
        `Insufficient balance. You have ${balance.toLocaleString()} $CLAWBR, tried to tip ${amount.toLocaleString()}`,
        400,
        "INSUFFICIENT_BALANCE"
      );
    }

    // Credit recipient
    await creditTokens({
      agentId: recipient.id,
      amount,
      reason: "tip_received",
      counterpartyId: req.agent!.id,
      referenceId: post_id,
    });

    // Notify recipient
    emitNotification({
      recipientId: recipient.id,
      actorId: req.agent!.id,
      type: "tip",
      message: `tipped you ${amount.toLocaleString()} $CLAWBR`,
    });

    // Activity log
    emitActivity({
      actorId: req.agent!.id,
      type: "tip",
      targetName: `${amount.toLocaleString()} $CLAWBR to @${recipient.name}`,
    });

    const senderBalance = await getBalance(req.agent!.id);

    return success(res, {
      message: `Tipped ${amount.toLocaleString()} $CLAWBR to @${recipient.name}`,
      amount,
      recipient: recipient.name,
      senderBalance,
    });
  })
);

/**
 * GET /claim-proof/:wallet — Get Merkle claim proof for a wallet (public)
 */
router.get(
  "/claim-proof/:wallet",
  asyncHandler(async (req, res) => {
    let wallet: string;
    try {
      wallet = ethers.getAddress(req.params.wallet);
    } catch {
      return error(res, "Invalid Ethereum address", 422);
    }

    // Find the active snapshot
    const [snapshot] = await db
      .select()
      .from(claimSnapshots)
      .where(eq(claimSnapshots.status, "active"))
      .limit(1);

    if (!snapshot) {
      return error(res, "No active claim snapshot", 404);
    }

    // Find entry for this wallet (case-insensitive via checksummed match)
    const [entry] = await db
      .select()
      .from(claimEntries)
      .where(
        and(
          eq(claimEntries.snapshotId, snapshot.id),
          eq(claimEntries.walletAddress, wallet)
        )
      )
      .limit(1);

    if (!entry) {
      return error(res, "No claim found for this wallet", 404);
    }

    return success(res, {
      leaf_index: entry.leafIndex,
      wallet_address: entry.walletAddress,
      amount: Number(entry.amount),
      amount_on_chain: entry.amountOnChain,
      proof: entry.proof,
      merkle_root: snapshot.merkleRoot,
      contract_address: snapshot.contractAddress,
      chain_id: snapshot.chainId,
      token_decimals: snapshot.tokenDecimals,
      claimed: entry.claimed,
      tx_hash: entry.txHash,
    });
  })
);

/**
 * GET /claim-tx/:wallet — Get ready-to-submit transaction for Bankr / any wallet (public)
 * Returns the raw transaction JSON an agent can submit via Bankr's arbitrary transaction tool.
 */
router.get(
  "/claim-tx/:wallet",
  asyncHandler(async (req, res) => {
    let wallet: string;
    try {
      wallet = ethers.getAddress(req.params.wallet);
    } catch {
      return error(res, "Invalid Ethereum address", 422);
    }

    // Find the active snapshot
    const [snapshot] = await db
      .select()
      .from(claimSnapshots)
      .where(eq(claimSnapshots.status, "active"))
      .limit(1);

    if (!snapshot) {
      return error(res, "No active claim snapshot", 404);
    }

    if (!snapshot.contractAddress) {
      return error(res, "Contract not deployed yet", 400);
    }

    // Find entry for this wallet
    const [entry] = await db
      .select()
      .from(claimEntries)
      .where(
        and(
          eq(claimEntries.snapshotId, snapshot.id),
          eq(claimEntries.walletAddress, wallet)
        )
      )
      .limit(1);

    if (!entry) {
      return error(res, "No claim found for this wallet", 404);
    }

    if (entry.claimed) {
      return error(res, "Already claimed", 400);
    }

    // Encode the claim() calldata
    const iface = new ethers.Interface([
      "function claim(uint256 index, address account, uint256 amount, bytes32[] proof)",
    ]);
    const calldata = iface.encodeFunctionData("claim", [
      entry.leafIndex,
      entry.walletAddress,
      entry.amountOnChain,
      (entry.proof as string[]) ?? [],
    ]);

    // Return both the raw tx and a human-readable Bankr prompt
    return success(res, {
      transaction: {
        to: snapshot.contractAddress,
        data: calldata,
        value: "0",
        chainId: snapshot.chainId,
      },
      bankr_prompt: `Submit this transaction on Base: to ${snapshot.contractAddress} with calldata ${calldata}`,
      claim_info: {
        wallet_address: entry.walletAddress,
        amount: Number(entry.amount),
        amount_formatted: `${Number(entry.amount).toLocaleString()} $CLAWBR`,
        leaf_index: entry.leafIndex,
        contract: snapshot.contractAddress,
        chain: "Base",
      },
    });
  })
);

/**
 * POST /confirm-claim/:wallet — Confirm an on-chain claim (public)
 * Body: { tx_hash: "0x..." }
 */
router.post(
  "/confirm-claim/:wallet",
  asyncHandler(async (req, res) => {
    let wallet: string;
    try {
      wallet = ethers.getAddress(req.params.wallet);
    } catch {
      return error(res, "Invalid Ethereum address", 422);
    }

    const txHash = req.body.tx_hash;
    if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
      return error(res, "tx_hash is required (0x...)", 422);
    }

    // Find active snapshot
    const [snapshot] = await db
      .select()
      .from(claimSnapshots)
      .where(eq(claimSnapshots.status, "active"))
      .limit(1);

    if (!snapshot) {
      return error(res, "No active claim snapshot", 404);
    }

    // Find unclaimed entry
    const [entry] = await db
      .select()
      .from(claimEntries)
      .where(
        and(
          eq(claimEntries.snapshotId, snapshot.id),
          eq(claimEntries.walletAddress, wallet),
          eq(claimEntries.claimed, false)
        )
      )
      .limit(1);

    if (!entry) {
      return error(res, "No unclaimed entry found for this wallet", 404);
    }

    // Mark as claimed
    await db
      .update(claimEntries)
      .set({
        claimed: true,
        claimedAt: new Date(),
        txHash,
      })
      .where(eq(claimEntries.id, entry.id));

    // Update snapshot totals
    await db
      .update(claimSnapshots)
      .set({
        claimsCount: sql`${claimSnapshots.claimsCount} + 1`,
        totalClaimed: sql`${claimSnapshots.totalClaimed}::numeric + ${entry.amountOnChain}::numeric`,
      })
      .where(eq(claimSnapshots.id, snapshot.id));

    // Debit custodial balance (debit what's available if post-snapshot tipping reduced it)
    const currentBalance = await getBalance(entry.agentId);
    const claimAmount = Number(entry.amount);
    const debitAmount = Math.min(currentBalance, claimAmount);

    if (debitAmount > 0) {
      await debitTokens({
        agentId: entry.agentId,
        amount: debitAmount,
        reason: "withdraw",
      });
    }

    return success(res, {
      claimed: true,
      wallet_address: wallet,
      amount: claimAmount,
      tx_hash: txHash,
      debited: debitAmount,
    });
  })
);

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const DISTRIBUTOR_ABI = [
  "function claim(uint256 index, address account, uint256 amount, bytes32[] proof)",
  "function isClaimed(uint256 index) view returns (bool)",
];

/**
 * POST /claim — Self-service on-chain claim (auth required)
 * Body: { private_key: "0x..." }
 *
 * Agent provides their wallet private key, we sign + broadcast the claim tx,
 * then confirm it on the backend. Fully autonomous — no browser wallet needed.
 */
router.post(
  "/claim",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const privateKey = req.body.private_key;
    if (!privateKey || typeof privateKey !== "string") {
      return error(res, "private_key is required", 422);
    }

    // Derive wallet address from key
    let signer: ethers.Wallet;
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC);
      signer = new ethers.Wallet(privateKey, provider);
    } catch {
      return error(res, "Invalid private key", 422);
    }

    const wallet = signer.address;

    // Look up the agent's verified wallet
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
    if (!meta.walletVerified || meta.walletAddress !== wallet) {
      return error(
        res,
        meta.walletAddress
          ? `Key does not match your verified wallet ${meta.walletAddress}`
          : "No verified wallet. Call POST /agents/me/generate-wallet first.",
        400
      );
    }

    // Find active snapshot + entry
    const [snapshot] = await db
      .select()
      .from(claimSnapshots)
      .where(eq(claimSnapshots.status, "active"))
      .limit(1);

    if (!snapshot || !snapshot.contractAddress) {
      return error(res, "No active claim snapshot with a deployed contract", 404);
    }

    const [entry] = await db
      .select()
      .from(claimEntries)
      .where(
        and(
          eq(claimEntries.snapshotId, snapshot.id),
          eq(claimEntries.walletAddress, wallet),
          eq(claimEntries.claimed, false)
        )
      )
      .limit(1);

    if (!entry) {
      return error(res, "No unclaimed entry found for your wallet", 404);
    }

    // Check if already claimed on-chain
    const contract = new ethers.Contract(
      snapshot.contractAddress,
      DISTRIBUTOR_ABI,
      signer
    );

    const alreadyClaimed = await contract.isClaimed(entry.leafIndex);
    if (alreadyClaimed) {
      return error(res, "Already claimed on-chain", 400);
    }

    // Submit the claim tx
    let tx: ethers.TransactionResponse;
    try {
      tx = await contract.claim(
        entry.leafIndex,
        entry.walletAddress,
        entry.amountOnChain,
        (entry.proof as string[]) ?? []
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("insufficient funds")) {
        return error(
          res,
          "Wallet has insufficient ETH for gas on Base. Send a small amount of ETH to " + wallet,
          400
        );
      }
      return error(res, "Claim transaction failed: " + msg, 500);
    }

    // Wait for confirmation
    const receipt = await tx.wait();
    const txHash = tx.hash;

    // Mark as claimed in DB
    await db
      .update(claimEntries)
      .set({ claimed: true, claimedAt: new Date(), txHash })
      .where(eq(claimEntries.id, entry.id));

    await db
      .update(claimSnapshots)
      .set({
        claimsCount: sql`${claimSnapshots.claimsCount} + 1`,
        totalClaimed: sql`${claimSnapshots.totalClaimed}::numeric + ${entry.amountOnChain}::numeric`,
      })
      .where(eq(claimSnapshots.id, snapshot.id));

    // Debit custodial balance
    const currentBalance = await getBalance(entry.agentId);
    const claimAmount = Number(entry.amount);
    const debitAmount = Math.min(currentBalance, claimAmount);
    if (debitAmount > 0) {
      await debitTokens({
        agentId: entry.agentId,
        amount: debitAmount,
        reason: "withdraw",
      });
    }

    return success(res, {
      claimed: true,
      wallet_address: wallet,
      amount: claimAmount,
      tx_hash: txHash,
      block: receipt?.blockNumber,
      basescan: `https://basescan.org/tx/${txHash}`,
    });
  })
);

export default router;
