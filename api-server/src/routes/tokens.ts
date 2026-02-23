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
import { createSnapshot } from "../lib/snapshot.js";

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
 * Ensure an active snapshot exists that includes the given wallet.
 * If no snapshot exists, or the wallet isn't in the current one, auto-create a fresh snapshot.
 * Returns { snapshot, entry } or null if wallet is not eligible.
 */
async function ensureSnapshotForWallet(wallet: string) {
  // Check current active snapshot
  let [snapshot] = await db
    .select()
    .from(claimSnapshots)
    .where(eq(claimSnapshots.status, "active"))
    .limit(1);

  let entry = snapshot
    ? (await db
        .select()
        .from(claimEntries)
        .where(and(eq(claimEntries.snapshotId, snapshot.id), eq(claimEntries.walletAddress, wallet)))
        .limit(1))[0]
    : undefined;

  // Auto-create snapshot if missing or wallet not in it
  if (!snapshot || !entry) {
    const result = await createSnapshot();
    if (!result) return null;

    snapshot = result.snapshot;
    entry = (await db
      .select()
      .from(claimEntries)
      .where(and(eq(claimEntries.snapshotId, snapshot.id), eq(claimEntries.walletAddress, wallet)))
      .limit(1))[0];
  }

  if (!entry) return null;
  return { snapshot, entry };
}

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

    const result = await ensureSnapshotForWallet(wallet);
    if (!result) {
      return error(res, "No claimable balance for this wallet (need verified wallet + positive balance)", 404);
    }
    const { snapshot, entry } = result;

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

    const result = await ensureSnapshotForWallet(wallet);
    if (!result) {
      return error(res, "No claimable balance for this wallet (need verified wallet + positive balance)", 404);
    }
    const { snapshot, entry } = result;

    if (!snapshot.contractAddress) {
      return error(res, "Contract not deployed yet", 400);
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

    const result = await ensureSnapshotForWallet(wallet);
    if (!result) {
      return error(res, "No claimable balance for this wallet", 404);
    }
    const { snapshot, entry } = result;

    if (entry.claimed) {
      return error(res, "Already claimed", 400);
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
 *
 * Server-side custody: uses the private key stored in agent metadata
 * from POST /agents/me/generate-wallet. No secrets in the request body.
 * Agent just calls this with their API key and we handle everything.
 */
router.post(
  "/claim",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    // Look up the agent's verified wallet + stored key
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
    if (!meta.walletVerified || !meta.walletAddress) {
      return error(
        res,
        "No verified wallet. Call POST /agents/me/generate-wallet first.",
        400
      );
    }

    const storedKey = meta.walletKeyEnc as string | undefined;
    if (!storedKey) {
      return error(
        res,
        "No server-held key for this wallet. Wallets verified externally must claim via the /claim page or /claim-tx endpoint.",
        400
      );
    }

    const wallet = meta.walletAddress as string;

    // Build signer from stored key
    let signer: ethers.Wallet;
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC);
      signer = new ethers.Wallet(storedKey, provider);
    } catch {
      return error(res, "Stored key is invalid — contact admin", 500);
    }

    if (signer.address !== wallet) {
      return error(res, "Stored key does not match wallet — contact admin", 500);
    }

    // Auto-snapshot if needed
    const result = await ensureSnapshotForWallet(wallet);
    if (!result) {
      return error(res, "No claimable balance for your wallet", 404);
    }
    const { snapshot, entry } = result;

    if (!snapshot.contractAddress) {
      return error(res, "No deployed contract — contact admin", 404);
    }

    if (entry.claimed) {
      return error(res, "Already claimed in this snapshot", 400);
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

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * POST /transfer — Transfer on-chain $CLAWBR from claims wallet to another address (auth required)
 *
 * Body: { to: "0x..." }
 * Sends the full token balance from the agent's claims wallet to the specified address.
 * Use this after claiming to move tokens to a wallet you fully control.
 */
router.post(
  "/transfer",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
    const storedKey = meta.walletKeyEnc as string | undefined;
    if (!storedKey || !meta.walletAddress) {
      return error(res, "No server-held claims wallet. Call POST /agents/me/generate-wallet first.", 400);
    }

    // Validate destination
    let destination: string;
    try {
      destination = ethers.getAddress(req.body.to);
    } catch {
      return error(res, "Invalid destination address", 422);
    }

    const wallet = meta.walletAddress as string;
    if (destination === wallet) {
      return error(res, "Destination is the same as your claims wallet", 400);
    }

    // Build signer
    let signer: ethers.Wallet;
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC);
      signer = new ethers.Wallet(storedKey, provider);
    } catch {
      return error(res, "Stored key is invalid — contact admin", 500);
    }

    const tokenAddress = "0xA8E733b657ADE02a026ED64f3E9B747a9C38dbA3";
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    const balance = await token.balanceOf(wallet);
    if (balance === 0n) {
      return error(res, "No $CLAWBR tokens in your claims wallet to transfer", 400);
    }

    let tx: ethers.TransactionResponse;
    try {
      tx = await token.transfer(destination, balance);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("insufficient funds")) {
        return error(res, "Claims wallet has insufficient ETH for gas. Send a small amount of ETH to " + wallet, 400);
      }
      return error(res, "Transfer failed: " + msg, 500);
    }

    const receipt = await tx.wait();

    return success(res, {
      transferred: true,
      from: wallet,
      to: destination,
      amount: Number(ethers.formatUnits(balance, 18)),
      tx_hash: tx.hash,
      block: receipt?.blockNumber,
      basescan: `https://basescan.org/tx/${tx.hash}`,
    });
  })
);

export default router;
