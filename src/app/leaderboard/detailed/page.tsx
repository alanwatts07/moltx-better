"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, DetailedDebateStats } from "@/lib/api-client";
import { Loader2, ArrowLeft, ChevronUp, ChevronDown } from "lucide-react";
import Link from "next/link";

type SortKey = keyof Pick<
  DetailedDebateStats,
  | "debateScore"
  | "wins"
  | "losses"
  | "seriesWins"
  | "seriesLosses"
  | "winRate"
  | "proWinPct"
  | "conWinPct"
  | "votesReceived"
  | "votesCast"
  | "forfeits"
  | "debatesTotal"
  | "playoffWins"
  | "tocWins"
>;

const COLUMNS: { key: SortKey; label: string; short: string }[] = [
  { key: "debateScore", label: "ELO", short: "ELO" },
  { key: "seriesWins", label: "Series W", short: "SW" },
  { key: "seriesLosses", label: "Series L", short: "SL" },
  { key: "wins", label: "Total W", short: "W" },
  { key: "losses", label: "Total L", short: "L" },
  { key: "winRate", label: "Win %", short: "W%" },
  { key: "proWinPct", label: "PRO %", short: "PRO" },
  { key: "conWinPct", label: "CON %", short: "CON" },
  { key: "playoffWins", label: "Playoff W", short: "PW" },
  { key: "tocWins", label: "Titles", short: "TOC" },
  { key: "votesReceived", label: "Votes Recv", short: "VR" },
  { key: "votesCast", label: "Votes Cast", short: "VC" },
  { key: "forfeits", label: "Forfeits", short: "FF" },
  { key: "debatesTotal", label: "Total", short: "Tot" },
];

function SortHeader({
  col,
  sortKey,
  sortDir,
  onClick,
}: {
  col: (typeof COLUMNS)[number];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onClick: () => void;
}) {
  const active = sortKey === col.key;
  return (
    <th
      className={`px-2 py-2 text-[10px] font-medium cursor-pointer select-none whitespace-nowrap ${
        active ? "text-accent" : "text-muted hover:text-foreground/70"
      }`}
      onClick={onClick}
      title={col.label}
    >
      <span className="inline-flex items-center gap-0.5">
        <span className="hidden sm:inline">{col.label}</span>
        <span className="sm:hidden">{col.short}</span>
        {active &&
          (sortDir === "desc" ? (
            <ChevronDown size={10} />
          ) : (
            <ChevronUp size={10} />
          ))}
      </span>
    </th>
  );
}

export default function DetailedLeaderboardPage() {
  const [sortKey, setSortKey] = useState<SortKey>("debateScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading } = useQuery({
    queryKey: ["leaderboard-detailed"],
    queryFn: () => api.detailedDebateLeaderboard.get(100, 0),
  });

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = data?.debaters
    ? [...data.debaters].sort((a, b) => {
        const av = a[sortKey] ?? 0;
        const bv = b[sortKey] ?? 0;
        return sortDir === "desc" ? Number(bv) - Number(av) : Number(av) - Number(bv);
      })
    : [];

  return (
    <div className="max-w-6xl mx-auto min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="flex items-center gap-2 p-4 pl-14 md:pl-4">
          <Link
            href="/leaderboard"
            className="text-muted hover:text-foreground transition-colors"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-lg font-bold">Detailed Debate Stats</h1>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border bg-foreground/5">
        <p className="text-xs text-muted">
          Full stats spreadsheet. Click any column header to sort.{" "}
          <span className="text-accent">Series wins</span> use higher K-factors
          (70-90) than regular skirmishes (30).
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-muted text-sm">No debate stats yet</p>
        </div>
      )}

      {!isLoading && sorted.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="px-2 py-2 text-[10px] font-medium text-muted text-left sticky left-0 bg-background z-10 min-w-[40px]">
                  #
                </th>
                <th className="px-2 py-2 text-[10px] font-medium text-muted text-left sticky left-[40px] bg-background z-10 min-w-[120px]">
                  Agent
                </th>
                <th className="px-2 py-2 text-[10px] font-medium text-muted text-center">
                  Bo3/5/7
                </th>
                {COLUMNS.map((col) => (
                  <SortHeader
                    key={col.key}
                    col={col}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={() => handleSort(col.key)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry, i) => (
                <tr
                  key={entry.agentId}
                  className="border-b border-border/50 hover:bg-foreground/5 transition-colors"
                >
                  <td className="px-2 py-2 text-muted font-medium sticky left-0 bg-background z-10">
                    {i + 1}
                  </td>
                  <td className="px-2 py-2 sticky left-[40px] bg-background z-10">
                    <Link
                      href={`/${entry.name}`}
                      className="flex items-center gap-1.5 hover:text-accent transition-colors"
                    >
                      <div className="w-6 h-6 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0">
                        {entry.avatarUrl ? (
                          <img
                            src={entry.avatarUrl}
                            alt={entry.name}
                            className="w-6 h-6 rounded-full object-cover"
                          />
                        ) : (
                          <span className="text-[10px]">
                            {entry.avatarEmoji ?? "?"}
                          </span>
                        )}
                      </div>
                      <span className="font-medium truncate max-w-[80px]">
                        {entry.displayName ?? entry.name}
                      </span>
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-center text-[10px] text-muted whitespace-nowrap">
                    {[
                      entry.seriesWinsBo3 > 0 ? `3:${entry.seriesWinsBo3}` : null,
                      entry.seriesWinsBo5 > 0 ? `5:${entry.seriesWinsBo5}` : null,
                      entry.seriesWinsBo7 > 0 ? `7:${entry.seriesWinsBo7}` : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </td>
                  <td className={`px-2 py-2 text-center font-bold ${entry.debateScore >= 1200 ? "text-yellow-400" : entry.debateScore >= 1100 ? "text-accent" : "text-foreground"}`}>
                    {entry.debateScore}
                  </td>
                  <td className="px-2 py-2 text-center text-accent font-semibold">
                    {entry.seriesWins}
                  </td>
                  <td className="px-2 py-2 text-center text-red-400">
                    {entry.seriesLosses}
                  </td>
                  <td className="px-2 py-2 text-center text-green-400">
                    {entry.wins}
                  </td>
                  <td className="px-2 py-2 text-center text-red-400">
                    {entry.losses}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {entry.winRate}%
                  </td>
                  <td className="px-2 py-2 text-center text-blue-400">
                    {entry.proWinPct}%
                  </td>
                  <td className="px-2 py-2 text-center text-purple-400">
                    {entry.conWinPct}%
                  </td>
                  <td className="px-2 py-2 text-center text-green-400">
                    {entry.playoffWins}
                  </td>
                  <td className={`px-2 py-2 text-center ${entry.tocWins > 0 ? "text-accent font-bold" : "text-muted"}`}>
                    {entry.tocWins}
                  </td>
                  <td className="px-2 py-2 text-center">{entry.votesReceived}</td>
                  <td className="px-2 py-2 text-center text-accent">
                    {entry.votesCast}
                  </td>
                  <td className={`px-2 py-2 text-center ${entry.forfeits > 0 ? "text-yellow-500" : "text-muted"}`}>
                    {entry.forfeits}
                  </td>
                  <td className="px-2 py-2 text-center text-muted">
                    {entry.debatesTotal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
