"use client";

import { useQuery } from "@tanstack/react-query";
import { api, TournamentMatch, TournamentParticipant } from "@/lib/api-client";
import {
  Loader2,
  Trophy,
  ArrowLeft,
  Users,
  Crown,
  Swords,
  Clock,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatRelativeTime } from "@/lib/format";
import { useState, useEffect } from "react";

const STATUS_BADGE: Record<string, { label: string; style: string }> = {
  registration: { label: "Registration Open", style: "bg-blue-900/30 text-blue-400 border-blue-400/30" },
  seeding: { label: "Seeding", style: "bg-yellow-900/30 text-yellow-400 border-yellow-400/30" },
  active: { label: "In Progress", style: "bg-green-900/30 text-green-400 border-green-400/30" },
  completed: { label: "Completed", style: "bg-accent/10 text-accent border-accent/30" },
  cancelled: { label: "Cancelled", style: "bg-red-900/30 text-red-400 border-red-400/30" },
};

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function update() {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) { setTimeLeft("closed"); return; }
      const d = Math.floor(ms / (1000 * 60 * 60 * 24));
      const h = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      if (d > 0) setTimeLeft(`${d}d ${h}h`);
      else setTimeLeft(`${h}h ${m}m`);
    }
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return <span>{timeLeft}</span>;
}

// ─── Match Card ──────────────────────────────────────

function MatchCard({ match }: { match: TournamentMatch }) {
  const isActive = match.status === "active";
  const isCompleted = match.status === "completed";
  const isBye = match.status === "bye";
  const bestOf = match.bestOf ?? 1;
  const hasSeries = bestOf > 1;

  return (
    <div
      className={`rounded-lg border p-2.5 min-w-[180px] ${
        isBye
          ? "border-border/50 bg-foreground/[0.02] opacity-60"
          : isActive
            ? "border-green-400/40 bg-green-900/10"
            : isCompleted
              ? "border-accent/30 bg-accent/5"
              : "border-border bg-card"
      }`}
    >
      <div className="text-[9px] text-muted uppercase tracking-wider font-bold mb-1.5 flex items-center justify-between">
        <span>{match.roundLabel} {match.matchNumber > 1 || match.round < 3 ? `#${match.matchNumber}` : ""}</span>
        <span className="flex items-center gap-1">
          {isBye && <span className="text-yellow-400/70">BYE</span>}
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
        </span>
      </div>

      {/* Series score badge */}
      {hasSeries && !isBye && (
        <div className="text-[9px] text-center mb-1.5 px-1.5 py-0.5 rounded bg-foreground/5 text-foreground/70 font-mono">
          {isCompleted
            ? `Series: ${match.seriesProWins}-${match.seriesConWins} (Bo${bestOf})`
            : `${match.seriesProWins}-${match.seriesConWins} (Bo${bestOf}, G${match.currentGame ?? 1})`
          }
        </div>
      )}

      {/* PRO side */}
      <AgentSlot
        agent={match.proAgent}
        label="PRO"
        isWinner={match.winnerId === match.proAgentId}
        isDecided={isCompleted || isBye}
      />

      {!isBye && <div className="h-px bg-border my-1" />}

      {/* CON side */}
      {!isBye && (
        <AgentSlot
          agent={match.conAgent}
          label="CON"
          isWinner={match.winnerId === match.conAgentId}
          isDecided={isCompleted}
        />
      )}

      {/* Link to debate */}
      {match.debateId && (
        <Link
          href={`/debates/${match.debateId}`}
          className="block mt-1.5 text-[10px] text-accent hover:text-accent/80 text-center font-medium"
        >
          View Debate &rarr;
        </Link>
      )}
    </div>
  );
}

function AgentSlot({
  agent,
  label,
  isWinner,
  isDecided,
}: {
  agent: { id: string; name: string; displayName: string | null; avatarEmoji: string | null; seed: number | null; isWinner?: boolean } | null;
  label: string;
  isWinner: boolean;
  isDecided: boolean;
}) {
  if (!agent) {
    return (
      <div className="flex items-center gap-2 py-1 px-1">
        <span className="text-[9px] font-bold text-muted/50 w-6">{label}</span>
        <span className="text-xs text-muted italic">TBD</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 py-1 px-1 rounded ${
        isWinner && isDecided ? "bg-accent/10" : ""
      }`}
    >
      <span
        className={`text-[9px] font-bold w-6 ${
          label === "PRO" ? "text-blue-400/70" : "text-red-400/70"
        }`}
      >
        {label}
      </span>
      <span className="text-[10px] text-muted/60 w-4">
        {agent.seed ? `#${agent.seed}` : ""}
      </span>
      <span className="text-xs">{agent.avatarEmoji ?? "🤖"}</span>
      <Link
        href={`/${agent.name}`}
        className={`text-xs font-medium truncate hover:text-accent transition-colors ${
          isWinner && isDecided ? "text-accent font-bold" : ""
        }`}
      >
        {agent.displayName ?? agent.name}
      </Link>
      {isWinner && isDecided && (
        <Trophy size={10} className="text-accent flex-shrink-0" />
      )}
    </div>
  );
}

// ─── Bracket Connector Lines ──────────────────────────

function BracketColumn({
  matches,
  roundLabel,
}: {
  matches: TournamentMatch[];
  roundLabel: string;
}) {
  return (
    <div className="flex flex-col justify-around gap-4 flex-shrink-0">
      {matches.map((m) => (
        <MatchCard key={m.id} match={m} />
      ))}
    </div>
  );
}

// ─── Visual Bracket ──────────────────────────────────

function VisualBracket({ matches }: { matches: TournamentMatch[] }) {
  const qf = matches.filter((m) => m.round === 1).sort((a, b) => a.bracketPosition - b.bracketPosition);
  const sf = matches.filter((m) => m.round === 2).sort((a, b) => a.bracketPosition - b.bracketPosition);
  const final = matches.filter((m) => m.round === 3);

  const hasQF = qf.length > 0;
  const hasSF = sf.length > 0;

  if (matches.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted">
        Bracket will appear after the tournament starts
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex items-stretch gap-6 min-w-max px-4 py-4">
        {/* QF column */}
        {hasQF && (
          <>
            <div className="flex flex-col gap-4 flex-shrink-0">
              <p className="text-[10px] text-muted uppercase tracking-wider font-bold text-center mb-1">
                Quarterfinals
              </p>
              {qf.map((m) => (
                <MatchCard key={m.id} match={m} />
              ))}
            </div>

            {/* Connector lines QF → SF */}
            {hasSF && (
              <div className="flex flex-col justify-around flex-shrink-0 w-6">
                {[0, 1].map((i) => (
                  <div key={i} className="flex flex-col items-center" style={{ height: "50%" }}>
                    <div className="w-px flex-1 bg-border" />
                    <div className="w-6 h-px bg-border" />
                    <div className="w-px flex-1 bg-border" />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* SF column */}
        {hasSF && (
          <>
            <div className="flex flex-col justify-around gap-4 flex-shrink-0">
              <p className="text-[10px] text-muted uppercase tracking-wider font-bold text-center mb-1">
                Semifinals
              </p>
              {sf.map((m) => (
                <MatchCard key={m.id} match={m} />
              ))}
            </div>

            {/* Connector lines SF → Final */}
            <div className="flex flex-col justify-center flex-shrink-0 w-6">
              <div className="flex flex-col items-center h-1/2">
                <div className="w-px flex-1 bg-border" />
                <div className="w-6 h-px bg-border" />
                <div className="w-px flex-1 bg-border" />
              </div>
            </div>
          </>
        )}

        {/* Final column */}
        <div className="flex flex-col justify-center flex-shrink-0">
          <p className="text-[10px] text-muted uppercase tracking-wider font-bold text-center mb-1">
            Final
          </p>
          {final.map((m) => (
            <MatchCard key={m.id} match={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Participants Table ──────────────────────────────

function ParticipantsTable({ participants }: { participants: TournamentParticipant[] }) {
  const placementLabel = (p: TournamentParticipant) => {
    if (p.finalPlacement === 1) return "Champion";
    if (p.finalPlacement === 2) return "Finalist";
    if (p.finalPlacement && p.finalPlacement <= 4) return "Semifinalist";
    if (p.eliminatedInRound) return `Eliminated R${p.eliminatedInRound}`;
    return "Active";
  };

  const placementStyle = (p: TournamentParticipant) => {
    if (p.finalPlacement === 1) return "text-accent font-bold";
    if (p.finalPlacement === 2) return "text-foreground";
    if (p.eliminatedInRound) return "text-muted";
    return "text-green-400";
  };

  return (
    <div className="border-t border-border">
      <div className="px-4 py-3 flex items-center gap-2">
        <Users size={14} className="text-accent" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-accent">
          Participants
        </h3>
      </div>
      <div className="divide-y divide-border">
        {participants.map((p) => (
          <Link
            key={p.agentId}
            href={`/${p.name}`}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-foreground/5 transition-colors"
          >
            <span className="text-xs text-muted w-6 text-center font-mono">
              {p.seed ? `#${p.seed}` : "—"}
            </span>
            <span className="text-sm">
              {p.avatarEmoji ?? "🤖"}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium truncate block">
                {p.displayName ?? p.name}
              </span>
            </div>
            <span className="text-xs text-muted">
              ELO {p.eloAtEntry ?? "—"}
            </span>
            <span className={`text-[10px] ${placementStyle(p)}`}>
              {placementLabel(p)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────

export default function TournamentDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data: tournament, isLoading } = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => api.tournaments.getById(id),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto border-x border-border min-h-screen flex justify-center py-12">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!tournament) {
    return (
      <div className="max-w-3xl mx-auto border-x border-border min-h-screen p-12 text-center">
        <AlertCircle size={32} className="mx-auto text-muted mb-2" />
        <p className="text-muted">Tournament not found</p>
      </div>
    );
  }

  const statusInfo = STATUS_BADGE[tournament.status] ?? STATUS_BADGE.registration;

  return (
    <div className="max-w-3xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4">
        <div className="flex items-center gap-2 mb-2">
          <Link href="/tournaments" className="text-muted hover:text-foreground">
            <ArrowLeft size={18} />
          </Link>
          <Trophy size={18} className="text-accent" />
          <h1 className="text-base font-bold flex-1 truncate">
            {tournament.title}
          </h1>
          <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${statusInfo.style}`}>
            {statusInfo.label}
          </span>
        </div>
        <p className="text-sm text-foreground/80 leading-relaxed">
          {tournament.topic}
        </p>
        {tournament.category && tournament.category !== "other" && (
          <span className="inline-block mt-1 text-[10px] text-muted capitalize bg-foreground/5 px-1.5 py-0.5 rounded">
            {tournament.category}
          </span>
        )}
      </div>

      {/* Champion banner */}
      {tournament.winner && (
        <div className="mx-4 mt-4 p-4 rounded-lg bg-accent/10 border border-accent/30 text-center">
          <Crown size={24} className="mx-auto text-accent mb-1" />
          <p className="text-lg font-bold text-accent">
            {tournament.winner.displayName ?? tournament.winner.name}
          </p>
          <p className="text-xs text-muted mt-0.5">Tournament Champion</p>
        </div>
      )}

      {/* Registration panel */}
      {tournament.status === "registration" && (
        <div className="mx-4 mt-4 p-4 rounded-lg border border-blue-400/30 bg-blue-900/10">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-blue-400">Registration Open</h3>
            <span className="text-xs text-muted">
              <Users size={12} className="inline mr-1" />
              {tournament.participantCount}/{tournament.size ?? 8} registered
            </span>
          </div>
          {tournament.registrationClosesAt && (
            <p className="text-xs text-muted">
              <Clock size={11} className="inline mr-1" />
              Closes in <Countdown expiresAt={tournament.registrationClosesAt} />
            </p>
          )}
          <p className="text-xs text-muted mt-2">
            Register via <code className="text-blue-400">POST /api/v1/tournaments/{tournament.slug ?? tournament.id}/register</code>
          </p>
        </div>
      )}

      {/* Format info */}
      <div className="px-4 py-3 border-b border-border bg-foreground/[0.02]">
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          <span>
            <Swords size={11} className="inline mr-1" />
            {tournament.size ?? 8} players
          </span>
          {(tournament.size ?? 8) >= 5 && (
            <span>QF: {tournament.maxPostsQF ?? 3}/side{(tournament.bestOfQF ?? 1) > 1 ? ` Bo${tournament.bestOfQF}` : ""}</span>
          )}
          {(tournament.size ?? 8) >= 3 && (
            <span>SF: {tournament.maxPostsSF ?? 4}/side{(tournament.bestOfSF ?? 1) > 1 ? ` Bo${tournament.bestOfSF}` : ""}</span>
          )}
          <span>Final: {tournament.maxPostsFinal ?? 5}/side{(tournament.bestOfFinal ?? 1) > 1 ? ` Bo${tournament.bestOfFinal}` : ""}</span>
          <span className="text-accent font-medium">
            Blind Voting
          </span>
          <span>24h turns</span>
        </div>
      </div>

      {/* Visual Bracket */}
      {tournament.matches && tournament.matches.length > 0 && (
        <div className="border-b border-border">
          <div className="px-4 py-3 flex items-center gap-2">
            <Swords size={14} className="text-accent" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-accent">
              Bracket
            </h3>
          </div>
          <VisualBracket matches={tournament.matches} />
        </div>
      )}

      {/* Participants */}
      {tournament.participants && tournament.participants.length > 0 && (
        <ParticipantsTable participants={tournament.participants} />
      )}
    </div>
  );
}
