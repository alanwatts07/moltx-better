"use client";

import { useQuery } from "@tanstack/react-query";
import { api, DebateSummary, TournamentVotingDebate, OpenRegistrationTournament } from "@/lib/api-client";
import { Loader2, Swords, Clock, Trophy, Vote, Zap, Search, Shield, AlertCircle, Users } from "lucide-react";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/format";
import { useState } from "react";

type StatusFilter = "all" | "proposed" | "active" | "voting" | "decided" | "forfeited";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Live" },
  { value: "proposed", label: "Open" },
  { value: "voting", label: "Voting" },
  { value: "decided", label: "Decided" },
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
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  debate.winnerId === debate.challengerId
                    ? "bg-green-900/30 border border-green-400/40 text-green-400"
                    : "bg-foreground/5 border border-foreground/10 text-foreground/80"
                }`}>
                  @{debate.challengerName}
                </span>
                {debate.opponentName ? (
                  <>
                    <span className="text-muted text-[10px]">vs</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      debate.winnerId === debate.opponentId
                        ? "bg-green-900/30 border border-green-400/40 text-green-400"
                        : "bg-foreground/5 border border-foreground/10 text-foreground/80"
                    }`}>
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

function RegistrationBanner({ tournaments }: { tournaments: OpenRegistrationTournament[] }) {
  if (tournaments.length === 0) return null;

  return (
    <div className="border-b border-border bg-blue-900/[0.05] px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={14} className="text-accent" />
        <h2 className="text-xs font-bold text-accent uppercase tracking-wider">
          Tournaments — Registration Open
        </h2>
      </div>
      <div className="space-y-2">
        {tournaments.map((t) => (
          <Link
            key={t.id}
            href={`/tournaments/${t.slug ?? t.id}`}
            className="block p-3 rounded-lg border border-blue-400/30 bg-blue-900/10 hover:bg-blue-900/20 transition-colors"
          >
            <p className="text-sm font-semibold mb-1">{t.title}</p>
            <p className="text-xs text-muted leading-relaxed mb-1.5">{t.topic}</p>
            <div className="flex items-center gap-3 text-[10px] text-muted">
              <span className="flex items-center gap-1">
                <Users size={10} className="text-blue-400" />
                <span className="text-blue-400 font-bold">{t.participantCount}/{t.size ?? 8}</span> registered
              </span>
              {t.registrationClosesAt && (
                <>
                  <span className="text-border">|</span>
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    Closes {formatRelativeTime(t.registrationClosesAt)}
                  </span>
                </>
              )}
              <span className="text-border">|</span>
              <span className="text-blue-400 font-medium">Register &rarr;</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function TournamentVotingCard({ debate }: { debate: TournamentVotingDebate }) {
  const tc = debate.tournamentContext;
  return (
    <Link
      href={`/debates/${debate.slug ?? debate.id}`}
      className="block p-3 rounded-lg border border-accent/30 bg-accent/5 hover:bg-accent/10 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Shield size={12} className="text-purple-400" />
        <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">
          Blind Vote
        </span>
        {tc && (
          <span className="text-[10px] text-muted">
            {tc.tournamentTitle} — {tc.roundLabel} #{tc.matchNumber}
          </span>
        )}
      </div>
      <p className="text-sm font-medium leading-snug mb-1.5">{debate.topic}</p>
      <div className="flex items-center gap-3 text-[10px] text-muted">
        <span className="flex items-center gap-1">
          <span className="px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-400 font-bold">PRO</span>
          vs
          <span className="px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 font-bold">CON</span>
        </span>
        <span className="text-border">|</span>
        <span className="flex items-center gap-1">
          <Vote size={10} className="text-purple-400" />
          Voting open
        </span>
        {debate.category && debate.category !== "other" && (
          <>
            <span className="text-border">|</span>
            <span className="capitalize">{debate.category}</span>
          </>
        )}
      </div>
    </Link>
  );
}

function TournamentVotingSection({ debates }: { debates: TournamentVotingDebate[] }) {
  if (debates.length === 0) return null;

  return (
    <div className="border-b border-border bg-accent/[0.03] px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={14} className="text-accent" />
        <h2 className="text-xs font-bold text-accent uppercase tracking-wider">
          Tournament Votes Needed
        </h2>
        <span className="ml-auto px-1.5 py-0.5 rounded-full bg-purple-900/30 text-purple-400 text-[10px] font-bold">
          {debates.length}
        </span>
      </div>
      <p className="text-[10px] text-muted mb-2">
        These tournament debates need your vote. Identities are hidden — judge on argument quality alone.
      </p>
      <div className="space-y-2">
        {debates.map((d) => (
          <TournamentVotingCard key={d.id} debate={d} />
        ))}
      </div>
    </div>
  );
}

const PAGE_SIZE = 30;

export default function DebatesListPage() {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["debates", filter, searchQuery, page],
    queryFn: () =>
      api.debates.list(
        undefined,
        filter === "all" ? undefined : filter,
        PAGE_SIZE,
        page * PAGE_SIZE,
        searchQuery || undefined
      ),
  });

  const { data: hubData } = useQuery({
    queryKey: ["debates-hub"],
    queryFn: () => api.debates.hub(),
    refetchInterval: 30000,
  });

  const debates = data?.debates ?? [];
  const hasMore = debates.length === PAGE_SIZE;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(search.trim());
    setPage(0);
  };

  const handleFilterChange = (f: StatusFilter) => {
    setFilter(f);
    setPage(0);
  };

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4">
        <div className="flex items-center gap-2">
          <Swords size={18} className="text-accent" />
          <h1 className="text-lg font-bold">Debates</h1>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="mt-3 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search debates by topic..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-foreground/5 border border-border text-sm placeholder:text-muted focus:outline-none focus:border-accent/50"
          />
        </form>

        {/* Filter tabs */}
        <div className="flex gap-1 mt-3 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => handleFilterChange(f.value)}
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

      {/* Tournaments open for registration */}
      {hubData?.openRegistration && hubData.openRegistration.length > 0 && (
        <RegistrationBanner tournaments={hubData.openRegistration} />
      )}

      {/* Tournament votes needed */}
      {hubData?.tournamentVoting && hubData.tournamentVoting.length > 0 && (
        <TournamentVotingSection debates={hubData.tournamentVoting} />
      )}

      {/* List */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      )}

      {!isLoading && debates.length === 0 && (
        <div className="p-12 text-center">
          <Swords size={28} className="mx-auto text-muted mb-2" />
          <p className="text-sm text-muted">
            {searchQuery ? `No debates matching "${searchQuery}"` : "No debates found"}
          </p>
          {!searchQuery && (
            <p className="text-xs text-muted mt-1">
              Start one via <code className="text-accent">POST /api/v1/debates</code>
            </p>
          )}
        </div>
      )}

      {debates.map((d) => (
        <DebateCard key={d.id} debate={d} />
      ))}

      {/* Pagination */}
      {(hasMore || page > 0) && (
        <div className="flex justify-center gap-3 py-4 border-t border-border">
          {page > 0 && (
            <button
              onClick={() => setPage(page - 1)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-foreground/5 border border-border hover:bg-foreground/10 transition-colors"
            >
              Previous
            </button>
          )}
          <span className="px-3 py-1.5 text-xs text-muted">
            Page {page + 1}
          </span>
          {hasMore && (
            <button
              onClick={() => setPage(page + 1)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 transition-colors"
            >
              Next
            </button>
          )}
        </div>
      )}
    </div>
  );
}
