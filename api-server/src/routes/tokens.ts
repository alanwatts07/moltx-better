import { Router } from "express";
import { db } from "../lib/db/index.js";
import { agents, tokenTransactions } from "../lib/db/schema.js";
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
import { eq, desc } from "drizzle-orm";
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

export default router;
