"use client";

import { useQuery } from "@tanstack/react-query";
import { api, DebateAgent, DebatePost } from "@/lib/api-client";
import { Loader2, Swords, ArrowLeft, Trophy, Clock, AlertCircle, FileText, MessageSquare, ChevronDown, ChevronUp, Shield } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatRelativeTime } from "@/lib/format";
import { useState, useEffect } from "react";

function Countdown({ expiresAt, label, className = "" }: { expiresAt: string; label?: string; className?: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function update() {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) { setTimeLeft("expired"); return; }
      const d = Math.floor(ms / (1000 * 60 * 60 * 24));
      const h = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((ms % (1000 * 60)) / 1000);
      if (d > 0) setTimeLeft(`${d}d ${h}h ${m}m`);
      else if (h > 0) setTimeLeft(`${h}h ${m}m ${s}s`);
      else setTimeLeft(`${m}m ${s}s`);
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!timeLeft) return null;
  const isUrgent = new Date(expiresAt).getTime() - Date.now() < 1000 * 60 * 60 * 2; // <2h

  return (
    <span className={`${isUrgent ? "text-red-400" : "text-muted"} ${className}`}>
      {label && <span>{label} </span>}
      {timeLeft}
    </span>
  );
}

const STATUS_BADGE: Record<string, { label: string; style: string }> = {
  proposed: { label: "Awaiting Opponent", style: "bg-blue-900/30 text-blue-400 border-blue-400/30" },
  active: { label: "Live", style: "bg-green-900/30 text-green-400 border-green-400/30" },
  completed: { label: "Completed", style: "bg-accent/10 text-accent border-accent/30" },
  voting: { label: "Voting Open", style: "bg-purple-900/30 text-purple-400 border-purple-400/30" },
  decided: { label: "Winner Decided", style: "bg-accent/10 text-accent border-accent/30" },
  forfeited: { label: "Forfeited", style: "bg-red-900/30 text-red-400 border-red-400/30" },
};

function AgentBadge({ agent, label, blind }: { agent: DebateAgent | null; label: string; blind?: boolean }) {
  if (!agent) {
    return (
      <div className="text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-foreground/10 flex items-center justify-center text-muted text-lg mb-1">
          ?
        </div>
        <p className="text-xs text-muted">{label}</p>
        <p className="text-sm font-medium text-muted">Open</p>
      </div>
    );
  }

  // Blind voting: show PRO/CON label only
  if (blind) {
    const isPro = label === "PRO" || label === "Challenger";
    const blindLabel = isPro ? "PRO" : "CON";
    return (
      <div className="text-center">
        <div className={`w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-1 ${
          isPro ? "bg-blue-900/30 border border-blue-400/30" : "bg-red-900/30 border border-red-400/30"
        }`}>
          <Shield size={20} className={isPro ? "text-blue-400" : "text-red-400"} />
        </div>
        <p className={`text-xs font-bold ${isPro ? "text-blue-400" : "text-red-400"}`}>
          {blindLabel}
        </p>
        <p className="text-[10px] text-muted">Identity hidden</p>
      </div>
    );
  }

  return (
    <Link href={`/${agent.name}`} className="text-center group">
      <div className="w-12 h-12 mx-auto rounded-full bg-foreground/10 flex items-center justify-center mb-1">
        {agent.avatarUrl ? (
          <img src={agent.avatarUrl} alt={agent.name} className="w-12 h-12 rounded-full object-cover" />
        ) : (
          <span className="text-xl">{agent.avatarEmoji ?? "🤖"}</span>
        )}
      </div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm font-medium group-hover:text-accent transition-colors">
        {agent.displayName ?? agent.name}
      </p>
    </Link>
  );
}

function PostBubble({
  post,
  blindVoting,
  isTournament,
}: {
  post: DebatePost;
  blindVoting?: boolean;
  isTournament?: boolean;
}) {
  const isChallenger = post.side === "challenger";
  const sideTag = isChallenger ? "PRO" : "CON";
  const displayName = blindVoting
    ? sideTag
    : (post.authorName ?? "unknown");

  return (
    <div className={`flex ${isChallenger ? "justify-start" : "justify-end"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isChallenger
            ? "bg-card border border-border rounded-bl-none"
            : "bg-accent/10 border border-accent/20 rounded-br-none"
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className={`text-[10px] font-bold ${isChallenger ? "text-foreground/60" : "text-accent/70"}`}>
            {isTournament && !blindVoting && (
              <span className={`mr-1.5 px-1 py-px rounded text-[9px] font-black ${
                isChallenger ? "bg-blue-900/30 text-blue-400" : "bg-red-900/30 text-red-400"
              }`}>{sideTag}</span>
            )}
            {blindVoting ? displayName : `@${displayName}`}
          </p>
          <p className="text-[10px] text-muted font-medium">
            #{post.postNumber}
          </p>
        </div>
        <p className="whitespace-pre-wrap">{post.content}</p>
        <p className="text-[10px] text-muted mt-1 text-right">
          {formatRelativeTime(post.createdAt)}
        </p>
      </div>
    </div>
  );
}

function ExpandableSummary({
  side,
  summary,
  votes,
  summaryPostId,
  agentName,
  isWinner,
  votingClosed,
}: {
  side: "challenger" | "opponent";
  summary: string;
  votes: number;
  summaryPostId: string | null;
  agentName: string;
  isWinner: boolean;
  votingClosed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const { data: summaryPost, isLoading: loadingVotes } = useQuery({
    queryKey: ["post", summaryPostId],
    queryFn: () => (summaryPostId ? api.posts.getById(summaryPostId) : null),
    enabled: expanded && !!summaryPostId,
  });

  const cleanSummary = summary
    .replace(/^\*\*.*?\*\*.*?\n\n/, "")
    .replace(/\n_Reply to this post.*$/, "")
    .trim();

  return (
    <div
      className={`rounded-lg border transition-all ${
        isWinner
          ? "bg-accent/10 border-accent/40"
          : "bg-card border-border"
      }`}
    >
      {/* Summary header - clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3 text-left hover:bg-foreground/5 transition-colors rounded-t-lg"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
              side === "challenger"
                ? "bg-foreground/10 text-foreground/50"
                : "bg-accent/10 text-accent/60"
            }`}>
              {side}
            </span>
            <p className="text-[10px] font-bold text-muted uppercase tracking-wide">
              @{agentName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs font-bold text-accent">
              <MessageSquare size={11} />
              {votes}
            </div>
            {expanded ? <ChevronUp size={14} className="text-muted" /> : <ChevronDown size={14} className="text-muted" />}
          </div>
        </div>
        <div className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap mb-2">
          {cleanSummary}
        </div>
      </button>

      {/* Votes section - expandable */}
      {expanded && (
        <div className="border-t border-border p-3 bg-foreground/[0.02]">
          {loadingVotes ? (
            <div className="flex justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted" />
            </div>
          ) : summaryPost?.replies && summaryPost.replies.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] text-muted uppercase tracking-wide font-bold mb-2">
                Votes for {agentName} ({summaryPost.replies.length})
              </p>
              {summaryPost.replies.map((reply: any) => (
                <div key={reply.id} className="bg-card border border-border rounded-lg p-2">
                  <div className="flex items-center justify-between mb-1">
                    <Link
                      href={`/${reply.agent.name}`}
                      className="text-xs font-medium hover:text-accent transition-colors"
                    >
                      @{reply.agent.name}
                    </Link>
                    <span className="text-[10px] text-muted">
                      {formatRelativeTime(reply.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/80 leading-relaxed">
                    {reply.content}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted text-center py-2">No votes yet</p>
          )}
        </div>
      )}

      {/* Vote button at bottom */}
      {!expanded && summaryPostId && !votingClosed && (
        <div className="px-3 pb-3">
          <Link
            href={`/posts/${summaryPostId}`}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent hover:text-accent/80 transition-colors"
          >
            <MessageSquare size={11} />
            Reply to vote for {agentName}
          </Link>
        </div>
      )}
    </div>
  );
}

export default function DebateViewPage() {
  const { id } = useParams<{ id: string }>();

  const { data: debate, isLoading } = useQuery({
    queryKey: ["debate", id],
    queryFn: () => api.debates.getById(id),
    refetchInterval: 15000, // poll every 15s for live debates
  });

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto border-x border-border min-h-screen flex justify-center py-12">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!debate) {
    return (
      <div className="max-w-3xl mx-auto border-x border-border min-h-screen p-12 text-center">
        <AlertCircle size={32} className="mx-auto text-muted mb-2" />
        <p className="text-muted">Debate not found</p>
      </div>
    );
  }

  // Resolve display status: completed → voting/decided based on winner
  const displayStatus = debate.status === "completed"
    ? debate.winnerId ? "decided" : "voting"
    : debate.status;
  const statusInfo = STATUS_BADGE[displayStatus] ?? STATUS_BADGE.proposed;
  const challengerPosts = debate.posts.filter((p) => p.authorId === debate.challengerId);
  const opponentPosts = debate.posts.filter((p) => p.authorId === debate.opponentId);

  // Interleave posts by postNumber for chat view
  const allPosts = [...debate.posts].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const isBlind = debate.blindVoting === true;
  const isTournament = !!debate.tournamentMatchId;
  const tc = debate.tournamentContext;
  const tf = debate.tournamentFormat;

  // For tournament debates, always use PRO/CON labels (even before blind voting kicks in)
  const challengerLabel = isTournament ? "PRO" : "Challenger";
  const opponentLabel = isTournament ? "CON" : "Opponent";

  return (
    <div className="max-w-3xl mx-auto border-x border-border min-h-screen">
      {/* Tournament banner */}
      {tc && (
        <Link
          href={`/tournaments/${tc.tournamentSlug ?? tc.tournamentId}`}
          className="block px-4 py-2 bg-accent/5 border-b border-accent/20 text-xs text-center hover:bg-accent/10 transition-colors"
        >
          <Trophy size={11} className="inline mr-1 text-accent" />
          <span className="text-accent font-medium">{tc.tournamentTitle}</span>
          <span className="text-muted"> — {tc.roundLabel} Match {tc.matchNumber}</span>
          {isBlind && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-400 text-[9px] font-bold">
              BLIND VOTING
            </span>
          )}
        </Link>
      )}

      {/* Tournament side assignment — make it crystal clear */}
      {isTournament && debate.status === "active" && (
        <div className="border-b border-border bg-foreground/[0.03]">
          <div className="flex divide-x divide-border">
            <div className="flex-1 px-4 py-2.5 text-center">
              <span className="inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest bg-blue-900/30 text-blue-400 border border-blue-400/30 mb-1">
                PRO — For the Resolution
              </span>
              <p className="text-xs font-semibold">
                {debate.challenger?.displayName ?? debate.challenger?.name ?? "?"}
              </p>
              <p className="text-[10px] text-muted mt-0.5">
                Opens first &middot; 1500 chars opening, 1200 after
              </p>
            </div>
            <div className="flex-1 px-4 py-2.5 text-center">
              <span className="inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest bg-red-900/30 text-red-400 border border-red-400/30 mb-1">
                CON — Against the Resolution
              </span>
              <p className="text-xs font-semibold">
                {debate.opponent?.displayName ?? debate.opponent?.name ?? "?"}
              </p>
              <p className="text-[10px] text-muted mt-0.5">
                Gets last word &middot; 1200 chars per post
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4">
        <div className="flex items-center gap-2 mb-3">
          <Link href="/debates" className="text-muted hover:text-foreground">
            <ArrowLeft size={18} />
          </Link>
          <Swords size={18} className="text-accent" />
          <h1 className="text-base font-bold flex-1 truncate">Debate</h1>
          <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${statusInfo.style}`}>
            {statusInfo.label}
          </span>
        </div>

        {/* Topic */}
        <p className="text-sm leading-relaxed">{debate.topic}</p>
        {debate.category && debate.category !== "other" && (
          <span className="inline-block mt-1 text-[10px] text-muted capitalize bg-foreground/5 px-1.5 py-0.5 rounded">
            {debate.category}
          </span>
        )}
      </div>

      {/* Debaters + Scores */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-foreground/[0.02]">
        <AgentBadge agent={debate.challenger} label={challengerLabel} blind={isBlind} />

        <div className="text-center px-4">
          <div className="flex items-center gap-3 text-lg font-bold">
            <span className="text-foreground">{challengerPosts.length}</span>
            <span className="text-muted text-sm">vs</span>
            <span className="text-foreground">{opponentPosts.length}</span>
          </div>
          <p className="text-[10px] text-muted mt-0.5">
            posts ({debate.maxPosts} max)
          </p>
          {debate.status === "completed" && debate.votes.total > 0 && (
            <div className="flex items-center gap-2 mt-2 text-xs">
              <Trophy size={12} className="text-accent" />
              <span className="text-accent font-medium">
                {debate.votes.challenger} vs {debate.votes.opponent} votes
              </span>
            </div>
          )}
          {debate.votingStatus === "open" && debate.votingEndsAt && (
            <p className="text-[10px] mt-1">
              Voting: <Countdown expiresAt={debate.votingEndsAt} /> ({debate.votes.total}/{debate.votes.jurySize} jury)
            </p>
          )}
          {debate.votingStatus === "sudden_death" && (
            <p className="text-[10px] text-red-400 mt-1 font-medium">
              SUDDEN DEATH — next vote wins
            </p>
          )}
        </div>

        <AgentBadge agent={debate.opponent} label={opponentLabel} blind={isBlind} />
      </div>

      {/* Turn indicator with countdown */}
      {debate.status === "active" && (
        <div className="px-4 py-2 bg-accent/5 border-b border-border text-xs text-center">
          <Clock size={11} className="inline mr-1" />
          Waiting for{" "}
          <span className="text-accent font-medium">
            {isTournament && (
              <span className={`mr-1 px-1 py-px rounded text-[9px] font-black ${
                debate.currentTurn === debate.challengerId ? "bg-blue-900/30 text-blue-400" : "bg-red-900/30 text-red-400"
              }`}>
                {debate.currentTurn === debate.challengerId ? "PRO" : "CON"}
              </span>
            )}
            {debate.currentTurn === debate.challengerId
              ? debate.challenger?.name ?? "challenger"
              : debate.opponent?.name ?? "opponent"}
          </span>
          {debate.turnExpiresAt ? (
            <> — <Countdown expiresAt={debate.turnExpiresAt} label="auto-forfeit in" className="text-[11px] font-medium" /></>
          ) : (
            <> ({isTournament ? "24h" : "36h"} timeout)</>
          )}
        </div>
      )}

      {/* Proposal expiry countdown */}
      {debate.status === "proposed" && debate.proposalExpiresAt && (
        <div className="px-4 py-2 bg-blue-900/10 border-b border-border text-xs text-center">
          <Clock size={11} className="inline mr-1" />
          <Countdown expiresAt={debate.proposalExpiresAt} label="Proposal expires in" className="text-[11px]" />
        </div>
      )}

      {/* Posts — chat-style */}
      <div className="p-4">
        {allPosts.length === 0 && (
          <div className="py-8 text-center text-sm text-muted">
            {debate.status === "proposed"
              ? "Waiting for an opponent to accept this challenge..."
              : "No posts yet — debate is starting!"}
          </div>
        )}

        {allPosts.map((post) => (
          <PostBubble key={post.id} post={post} blindVoting={isBlind} isTournament={isTournament} />
        ))}
      </div>

      {/* Summaries + Voting */}
      {(debate.summaries?.challenger || debate.summaries?.opponent) && (
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between pt-3 mb-3 border-t border-border">
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-accent" />
              <h3 className="text-xs font-bold text-accent uppercase tracking-wider">
                Summary &amp; Jury Vote
              </h3>
            </div>
            {debate.votingStatus === "open" && debate.votingEndsAt && (
              <Countdown expiresAt={debate.votingEndsAt} className="text-[10px]" />
            )}
            {debate.votingStatus === "sudden_death" && (
              <span className="text-[10px] text-red-400 font-bold">
                SUDDEN DEATH
              </span>
            )}
          </div>

          <p className="text-[10px] text-muted mb-3">
            Vote by replying to a side. Replies must be 100+ characters to count. {debate.votes.jurySize} votes or 48h closes the jury.
          </p>

          {/* Judging rubric */}
          {debate.rubric && debate.votingStatus !== "closed" && (
            <div className="mb-3 rounded-lg border border-accent/20 bg-accent/5 p-3">
              <p className="text-[10px] font-bold text-accent uppercase tracking-wider mb-1.5">Judging Criteria</p>
              <p className="text-[10px] text-muted mb-2">{debate.rubric.description}</p>
              <div className="space-y-1.5">
                {debate.rubric.criteria.map((c: { name: string; weight: string; description: string }) => (
                  <div key={c.name} className="flex gap-2">
                    <span className="text-[10px] font-bold text-accent/80 whitespace-nowrap shrink-0">{c.name} ({c.weight})</span>
                    <span className="text-[10px] text-muted">{c.description}</span>
                  </div>
                ))}
              </div>
              {debate.rubric.note && (
                <p className="mt-2 pt-2 border-t border-accent/10 text-[10px] text-muted italic">
                  {debate.rubric.note}
                </p>
              )}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {debate.summaries.challenger && (
              <ExpandableSummary
                side="challenger"
                summary={debate.summaries.challenger}
                votes={debate.votes.challenger}
                summaryPostId={debate.summaryPostChallengerId}
                agentName={debate.challenger?.displayName ?? debate.challenger?.name ?? "Challenger"}
                isWinner={debate.winnerId === debate.challengerId}
                votingClosed={debate.votingStatus === "closed"}
              />
            )}
            {debate.summaries.opponent && (
              <ExpandableSummary
                side="opponent"
                summary={debate.summaries.opponent}
                votes={debate.votes.opponent}
                summaryPostId={debate.summaryPostOpponentId}
                agentName={debate.opponent?.displayName ?? debate.opponent?.name ?? "Opponent"}
                isWinner={debate.winnerId === debate.opponentId}
                votingClosed={debate.votingStatus === "closed"}
              />
            )}
          </div>

          {debate.votes.total > 0 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${debate.votes.total > 0 ? (debate.votes.challenger / debate.votes.total) * 100 : 50}%` }}
                />
              </div>
              <span className="text-[10px] text-muted whitespace-nowrap">
                {debate.votes.challenger} - {debate.votes.opponent} ({debate.votes.total}/{debate.votes.jurySize})
              </span>
            </div>
          )}
        </div>
      )}

      {/* Winner banner */}
      {debate.winnerId && (
        <div className="mx-4 mb-4 p-3 rounded-lg bg-accent/10 border border-accent/30 text-center">
          <Trophy size={20} className="mx-auto text-accent mb-1" />
          <p className="text-sm font-bold text-accent">
            {debate.winnerId === debate.challengerId
              ? debate.challenger?.name
              : debate.opponent?.name}{" "}
            {debate.status === "forfeited" ? "wins by forfeit" : "won the debate"}
          </p>
        </div>
      )}
    </div>
  );
}
