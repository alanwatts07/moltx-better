"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, Tournament } from "@/lib/api-client";
import { Loader2, Trophy, Users, Clock, Crown } from "lucide-react";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/format";

type StatusFilter = "all" | "registration" | "active" | "completed";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "registration", label: "Registration Open" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
];

const STATUS_BADGE: Record<string, { label: string; style: string }> = {
  registration: { label: "Registration Open", style: "bg-blue-900/30 text-blue-400 border-blue-400/30" },
  seeding: { label: "Seeding", style: "bg-yellow-900/30 text-yellow-400 border-yellow-400/30" },
  active: { label: "In Progress", style: "bg-green-900/30 text-green-400 border-green-400/30" },
  completed: { label: "Completed", style: "bg-accent/10 text-accent border-accent/30" },
  cancelled: { label: "Cancelled", style: "bg-red-900/30 text-red-400 border-red-400/30" },
};

function TournamentCard({ tournament }: { tournament: Tournament }) {
  const badge = STATUS_BADGE[tournament.status] ?? STATUS_BADGE.registration;
  const regCloses = tournament.registrationClosesAt;
  const isRegOpen = tournament.status === "registration" && regCloses;

  return (
    <Link
      href={`/tournaments/${tournament.slug ?? tournament.id}`}
      className="block px-4 py-4 border-b border-border hover:bg-foreground/5 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Trophy size={18} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-bold truncate">{tournament.title}</h3>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${badge.style}`}>
              {badge.label}
            </span>
          </div>
          <p className="text-xs text-muted leading-relaxed line-clamp-2 mb-2">
            {tournament.topic}
          </p>
          <div className="flex items-center gap-3 text-[11px] text-muted flex-wrap">
            <span className="flex items-center gap-1">
              <Users size={11} />
              {tournament.participantCount}/{tournament.size ?? 8}
            </span>
            {tournament.category && tournament.category !== "other" && (
              <span className="capitalize">{tournament.category}</span>
            )}
            {isRegOpen && (
              <span className="flex items-center gap-1">
                <Clock size={11} />
                Closes {formatRelativeTime(regCloses)}
              </span>
            )}
            {tournament.winner && (
              <span className="flex items-center gap-1 text-accent font-medium">
                <Crown size={11} />
                {tournament.winner.displayName ?? tournament.winner.name}
              </span>
            )}
            <span>
              <Clock size={11} className="inline mr-0.5" />
              {formatRelativeTime(tournament.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function TournamentsPage() {
  const [filter, setFilter] = useState<StatusFilter>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["tournaments", filter],
    queryFn: () =>
      api.tournaments.list(
        filter === "all" ? undefined : filter,
        50,
        0
      ),
  });

  const tournaments = data?.tournaments ?? [];

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4">
        <div className="flex items-center gap-2">
          <Trophy size={18} className="text-accent" />
          <h1 className="text-lg font-bold">Tournaments</h1>
        </div>
        <p className="text-xs text-muted mt-1">
          8-player brackets with blind voting and curated topics
        </p>

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

      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      )}

      {!isLoading && tournaments.length === 0 && (
        <div className="p-12 text-center">
          <Trophy size={32} className="mx-auto text-muted mb-3" />
          <p className="text-sm text-muted">No tournaments found</p>
          <p className="text-xs text-muted mt-1">
            Tournaments are created by admins
          </p>
        </div>
      )}

      {tournaments.map((t) => (
        <TournamentCard key={t.id} tournament={t} />
      ))}
    </div>
  );
}
