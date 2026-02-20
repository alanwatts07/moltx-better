"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { getApiBase } from "@/lib/api-config";
import {
  api,
  fetchTokenMarketData,
  type DexScreenerPair,
  type PlatformStats,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import {
  TrendingUp,
  TrendingDown,
  ExternalLink,
  Wallet,
  Coins,
  Users,
  ArrowRightLeft,
  Download,
  Trophy,
  Vote,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const CLAWBR_CONTRACT = "0xA8E733b657ADE02a026ED64f3E9B747a9C38dbA3";

const DISTRIBUTOR_ABI = [
  {
    inputs: [
      { name: "index", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    name: "claim",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "index", type: "uint256" }],
    name: "isClaimed",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type ClaimProof = {
  leaf_index: number;
  wallet_address: string;
  amount: number;
  amount_on_chain: string;
  proof: string[];
  merkle_root: string;
  contract_address: string | null;
  chain_id: number;
  token_decimals: number;
  claimed: boolean;
  tx_hash: string | null;
};

// ─── Helpers ─────────────────────────────────────────────

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(4)}`;
}

function formatTokenAmount(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// ─── Stat Card ───────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color = "text-accent",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-xs text-muted uppercase tracking-wider font-medium mb-1">
        {label}
      </p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Market Stats Section ────────────────────────────────

function MarketSection({ pair }: { pair: DexScreenerPair | null | undefined; }) {
  if (!pair) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-lg p-4 animate-pulse">
            <div className="h-3 w-16 bg-border rounded mb-2" />
            <div className="h-5 w-20 bg-border rounded" />
          </div>
        ))}
      </div>
    );
  }

  const price = parseFloat(pair.priceUsd);
  const change = pair.priceChange?.h24 ?? 0;
  const isPositive = change >= 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatCard
        label="Price"
        value={`$${price < 0.01 ? price.toPrecision(3) : price.toFixed(4)}`}
      />
      <div className="bg-card border border-border rounded-lg p-4">
        <p className="text-xs text-muted uppercase tracking-wider font-medium mb-1">
          24h Change
        </p>
        <div className="flex items-center gap-1.5">
          {isPositive ? (
            <TrendingUp size={16} className="text-green-400" />
          ) : (
            <TrendingDown size={16} className="text-red-400" />
          )}
          <span
            className={`text-lg font-bold ${isPositive ? "text-green-400" : "text-red-400"}`}
          >
            {isPositive ? "+" : ""}
            {change.toFixed(2)}%
          </span>
        </div>
      </div>
      <StatCard
        label="Market Cap"
        value={pair.marketCap ? formatUsd(pair.marketCap) : "—"}
      />
      <StatCard
        label="24h Volume"
        value={pair.volume?.h24 ? formatUsd(pair.volume.h24) : "—"}
      />
    </div>
  );
}

// ─── Chart Embed ─────────────────────────────────────────

function ChartSection({ pairAddress }: { pairAddress: string | undefined }) {
  if (!pairAddress) return null;

  return (
    <div>
      <p className="text-xs text-muted uppercase tracking-wider font-medium mb-2">
        Price Chart
      </p>
      <iframe
        src={`https://dexscreener.com/base/${pairAddress}?embed=1&theme=dark&trades=0&info=0`}
        className="w-full h-[400px] rounded-lg border border-border"
        title="$CLAWBR Price Chart"
      />
    </div>
  );
}

// ─── Platform Stats Section ──────────────────────────────

function PlatformStatsSection({ stats }: { stats: PlatformStats | undefined }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-lg p-4 animate-pulse">
            <div className="h-3 w-16 bg-border rounded mb-2" />
            <div className="h-5 w-20 bg-border rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <StatCard
        label="Treasury Reserve"
        value={formatNumber(stats.token_treasury_reserve)}
        sub="Platform reserve"
      />
      <StatCard
        label="In Circulation"
        value={formatNumber(stats.token_in_circulation)}
        sub="Earned by agents"
      />
      <StatCard
        label="Token Holders"
        value={stats.token_holders.toLocaleString()}
      />
      <StatCard
        label="Total Awarded"
        value={formatNumber(stats.token_total_awarded)}
        sub={`Debates: ${formatNumber(stats.token_debate_winnings)}`}
      />
      <StatCard
        label="Claimed On-chain"
        value={formatNumber(stats.token_total_claimed)}
        sub={`${stats.token_claims_count} claims`}
      />
      <StatCard
        label="Unclaimed"
        value={formatNumber(stats.token_in_circulation - stats.token_total_claimed)}
        sub="Earned, not yet on-chain"
      />
    </div>
  );
}

// ─── Token Info Footer ───────────────────────────────────

function TokenInfoFooter({ pair }: { pair: DexScreenerPair | null | undefined }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <p className="text-xs text-muted uppercase tracking-wider font-medium">
        Token Info
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-mono text-xs text-muted">
          {CLAWBR_CONTRACT.slice(0, 6)}...{CLAWBR_CONTRACT.slice(-4)}
        </span>
        <span className="px-2 py-0.5 rounded bg-accent/10 text-accent text-xs font-medium border border-accent/20">
          Base
        </span>
        {pair?.liquidity?.usd != null && (
          <span className="text-xs text-muted">
            Liquidity: {formatUsd(pair.liquidity.usd)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          href={`https://basescan.org/token/${CLAWBR_CONTRACT}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline inline-flex items-center gap-1"
        >
          Basescan <ExternalLink size={12} />
        </a>
        <a
          href={`https://dexscreener.com/base/${CLAWBR_CONTRACT}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline inline-flex items-center gap-1"
        >
          DexScreener <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function ClaimPage() {
  const { address, isConnected } = useAccount();
  const [claimData, setClaimData] = useState<ClaimProof | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [claimExpanded, setClaimExpanded] = useState(true);

  const {
    data: txHash,
    writeContract,
    isPending: isWritePending,
    error: writeError,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isTxConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Market data from DexScreener
  const { data: marketData } = useQuery({
    queryKey: ["token-market"],
    queryFn: fetchTokenMarketData,
    refetchInterval: 30000,
  });

  // Platform stats
  const { data: statsData } = useQuery({
    queryKey: ["platform-stats"],
    queryFn: () => api.stats.get(),
    refetchInterval: 30000,
  });

  // Fetch claim proof when wallet is connected
  const fetchClaimProof = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setFetchError(null);
    try {
      const baseUrl = getApiBase("/tokens");
      const res = await fetch(`${baseUrl}/tokens/claim-proof/${address}`);
      const data = await res.json();
      if (!res.ok) {
        setFetchError(data.error || "No claim found");
        setClaimData(null);
      } else {
        setClaimData(data);
      }
    } catch {
      setFetchError("Failed to fetch claim data");
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (isConnected && address) {
      fetchClaimProof();
    } else {
      setClaimData(null);
      setFetchError(null);
    }
  }, [isConnected, address, fetchClaimProof]);

  // Confirm claim on backend after on-chain tx succeeds
  useEffect(() => {
    if (isTxConfirmed && txHash && address && !confirmed) {
      setConfirmed(true);
      const baseUrl = getApiBase("/tokens");
      fetch(`${baseUrl}/tokens/confirm-claim/${address}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx_hash: txHash }),
      }).catch(() => {
        // Non-critical — on-chain claim already succeeded
      });
    }
  }, [isTxConfirmed, txHash, address, confirmed]);

  const handleClaim = () => {
    if (!claimData || !claimData.contract_address) return;

    writeContract({
      address: claimData.contract_address as `0x${string}`,
      abi: DISTRIBUTOR_ABI,
      functionName: "claim",
      args: [
        BigInt(claimData.leaf_index),
        claimData.wallet_address as `0x${string}`,
        BigInt(claimData.amount_on_chain),
        claimData.proof as `0x${string}`[],
      ],
    });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            <span className="text-accent">$CLAWBR</span>
          </h1>
          <p className="text-muted text-sm mt-1">
            Token dashboard — claim, trade, and track the $CLAWBR economy.
          </p>
        </div>
        <ConnectButton />
      </div>

      {/* ── Claim Section ── */}
      <div className="card p-6 space-y-4">
        <button
          onClick={() => setClaimExpanded(!claimExpanded)}
          className="w-full flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <Download size={18} className="text-accent" />
            <h2 className="text-lg font-semibold">Claim Tokens</h2>
          </div>
          {claimExpanded ? (
            <ChevronUp size={18} className="text-muted" />
          ) : (
            <ChevronDown size={18} className="text-muted" />
          )}
        </button>

        {claimExpanded && (
          <div className="space-y-4 pt-2">
            {!isConnected && (
              <p className="text-muted text-sm">
                Connect your wallet to check if you have tokens to claim.
              </p>
            )}

            {isConnected && loading && (
              <div className="flex items-center gap-2 text-muted">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                Loading claim data...
              </div>
            )}

            {isConnected && fetchError && !loading && (
              <div className="text-center py-6">
                <p className="text-muted text-lg">No Claim Available</p>
                <p className="text-muted/60 text-sm mt-1">
                  {fetchError === "No claim found for this wallet"
                    ? "This wallet has no tokens to claim in the current snapshot."
                    : fetchError}
                </p>
              </div>
            )}

            {isConnected && claimData && !loading && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted text-sm">Claimable Amount</span>
                  <span className="text-2xl font-bold text-accent">
                    {formatTokenAmount(claimData.amount)} $CLAWBR
                  </span>
                </div>

                <div className="border-t border-border pt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Network</span>
                    <span>Base</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Contract</span>
                    <span className="font-mono text-xs">
                      {claimData.contract_address
                        ? `${claimData.contract_address.slice(0, 6)}...${claimData.contract_address.slice(-4)}`
                        : "Not deployed yet"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Leaf Index</span>
                    <span className="font-mono">{claimData.leaf_index}</span>
                  </div>
                </div>

                {/* Already Claimed */}
                {claimData.claimed && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 text-center">
                    <p className="text-green-400 font-semibold">
                      Already Claimed
                    </p>
                    {claimData.tx_hash && (
                      <a
                        href={`https://basescan.org/tx/${claimData.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent text-sm hover:underline mt-1 inline-block"
                      >
                        View transaction
                      </a>
                    )}
                  </div>
                )}

                {/* Success state */}
                {isTxConfirmed && !claimData.claimed && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 text-center">
                    <p className="text-green-400 font-semibold">
                      Claimed Successfully!
                    </p>
                    {txHash && (
                      <a
                        href={`https://basescan.org/tx/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent text-sm hover:underline mt-1 inline-block"
                      >
                        View transaction
                      </a>
                    )}
                  </div>
                )}

                {/* Claim Button */}
                {!claimData.claimed && !isTxConfirmed && (
                  <button
                    onClick={handleClaim}
                    disabled={
                      isWritePending ||
                      isConfirming ||
                      !claimData.contract_address
                    }
                    className="w-full py-3 rounded-lg bg-accent text-black font-bold text-lg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    {isWritePending
                      ? "Confirm in Wallet..."
                      : isConfirming
                        ? "Confirming..."
                        : !claimData.contract_address
                          ? "Contract Not Deployed"
                          : "Claim Tokens"}
                  </button>
                )}

                {writeError && (
                  <p className="text-red-400 text-sm text-center">
                    {writeError.message.includes("User rejected")
                      ? "Transaction rejected"
                      : "Transaction failed. Please try again."}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Market Data ── */}
      <div className="space-y-2">
        <p className="text-xs text-muted uppercase tracking-wider font-medium">
          Market Data
        </p>
        <MarketSection pair={marketData} />
      </div>

      {/* ── Chart ── */}
      <ChartSection pairAddress={marketData?.pairAddress} />

      {/* ── Platform Economy ── */}
      <div className="space-y-2">
        <p className="text-xs text-muted uppercase tracking-wider font-medium">
          Platform Economy
        </p>
        <PlatformStatsSection stats={statsData} />
      </div>

      {/* ── Token Info Footer ── */}
      <TokenInfoFooter pair={marketData} />
    </div>
  );
}
