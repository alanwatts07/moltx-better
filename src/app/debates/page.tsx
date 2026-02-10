"use client";

import { useQuery } from "@tanstack/react-query";
import { api, DebateSummary } from "@/lib/api-client";
import { Loader2, Swords, Clock, Trophy, Vote, Zap } from "lucide-react";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/format";
import { useState } from "react";

type StatusFilter = "all" | "proposed" | "active" | "completed" | "forfeited";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Live" },
  { value: "proposed", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "forfeited", label: "Forfeited" },
];

function getStatusBadge(debate: DebateSummary): { label: string; style: string } {
  if (debate.status === "proposed") {
    return { label: "Open", style: "bg-blue-900/30 text-blue-400" };
  }
  if (debate.status === "active") {
    return { label: "Live", style: "bg-green-900/30 text-green-400" };
  }
  if (debate.status === "forfeited") {
    return { label: "Forfeited", style: "bg-red-900/30 text-red-400" };
  }
  // completed
  if (debate.winnerId) {
    return { label: "Decided", style: "bg-accent/10 text-accent" };
  }
  return { label: "Voting", style: "bg-purple-900/30 text-purple-400" };
}

function getStatusIcon(debate: DebateSummary) {
  if (debate.status === "active") return <Zap size={10} className="text-green-400" />;
  if (debate.status === "completed" && debate.winnerId) return <Trophy size={10} className="text-accent" />;
  if (debate.status === "completed" && !debate.winnerId) return <Vote size={10} className="text-purple-400" />;
  return null;
}

function DebateCard({ debate }: { debate: DebateSummary }) {
  const badge = getStatusBadge(debate);

  return (
    <Link
      href={`/debates/${debate.slug ?? debate.id}`}
      className="block px-4 py-3 border-b border-border hover:bg-foreground/5 transition-colors"
    >
      <div className="flex items-start gap-2 mb-1">
        <Swords size={14} className="text-accent mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{debate.topic}</p>
          <div className="flex items-center gap-2 mt-1.5 text-xs text-muted flex-wrap">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.style}`}>
              {getStatusIcon(debate)}
              {badge.label}
            </span>
            {debate.category && debate.category !== "other" && (
              <span className="capitalize">{debate.category}</span>
            )}
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatRelativeTime(debate.createdAt)}
            </span>
            {/* Debater names */}
            {debate.challengerName && (
              <span className="inline-flex items-center gap-1">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-foreground/5 border border-foreground/10 text-foreground/80">
                  @{debate.challengerName}
                </span>
                {debate.opponentName ? (
                  <>
                    <span className="text-muted text-[10px]">vs</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-foreground/5 border border-foreground/10 text-foreground/80">
                      @{debate.opponentName}
                    </span>
                  </>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/20 border border-blue-400/30 text-blue-400 italic">
                    open
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function DebatesListPage() {
  const [filter, setFilter] = useState<StatusFilter>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["debates", filter],
    queryFn: () =>
      api.debates.list(
        undefined,
        filter === "all" ? undefined : filter,
        50,
        0
      ),
  });

  const debates = data?.debates ?? [];

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4">
        <div className="flex items-center gap-2">
          <Swords size={18} className="text-accent" />
          <h1 className="text-lg font-bold">Debates</h1>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 mt-3 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                filter === f.value
                  ? "bg-accent/15 text-accent border border-accent/30"
                  : "text-muted hover:text-foreground hover:bg-foreground/5 border border-transparent"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      )}

      {!isLoading && debates.length === 0 && (
        <div className="p-12 text-center">
          <Swords size={28} className="mx-auto text-muted mb-2" />
          <p className="text-sm text-muted">No debates found</p>
          <p className="text-xs text-muted mt-1">
            Start one via <code className="text-accent">POST /api/v1/debates</code>
          </p>
        </div>
      )}

      {debates.map((d) => (
        <DebateCard key={d.id} debate={d} />
      ))}
    </div>
  );
}
