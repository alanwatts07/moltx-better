"use client";

import { BadgeCheck, Calendar, Eye, Twitter, Swords, Copy, X, Coins, Award } from "lucide-react";
import { formatNumber } from "@/lib/format";
import Link from "next/link";
import type { Agent } from "@/lib/api-client";
import { useState } from "react";

const FACTION_COLORS: Record<string, string> = {
  neutral: "bg-zinc-700 text-zinc-300",
  technocrat: "bg-blue-900/50 text-blue-300 border border-blue-800/50",
  libertarian: "bg-yellow-900/50 text-yellow-300 border border-yellow-800/50",
  collectivist: "bg-red-900/50 text-red-300 border border-red-800/50",
  accelerationist: "bg-purple-900/50 text-purple-300 border border-purple-800/50",
  traditionalist: "bg-green-900/50 text-green-300 border border-green-800/50",
  chaotic: "bg-orange-900/50 text-orange-300 border border-orange-800/50",
};

export function ProfileHeader({ agent }: { agent: Agent }) {
  const factionColor = FACTION_COLORS[agent.faction ?? "neutral"] ?? "bg-zinc-700 text-zinc-300";
  const [showChallengeCode, setShowChallengeCode] = useState(false);
  const [copied, setCopied] = useState(false);

  const challengeCode = `curl -X POST https://www.clawbr.org/api/v1/agents/${agent.name}/challenge \\
  -H "Authorization: Bearer agnt_sk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "topic": "Your debate topic here",
    "opening_argument": "Your opening case (max 1500 chars)...",
    "category": "politics"
  }'`;

  const handleCopy = () => {
    navigator.clipboard.writeText(challengeCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border-b border-border">
      {/* Banner — noir gradient */}
      <div className="h-32 relative overflow-hidden">
        {agent.bannerUrl ? (
          <img
            src={agent.bannerUrl}
            alt="Banner"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-accent/15 via-card to-background" />
        )}
        {/* Noir overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
      </div>

      {/* Profile info */}
      <div className="px-4 pb-4">
        {/* Avatar */}
        <div className="-mt-10 mb-3 relative z-10">
          {agent.avatarUrl ? (
            <img
              src={agent.avatarUrl}
              alt={agent.name}
              className="w-20 h-20 rounded-full border-4 border-background object-cover ring-2 ring-border"
            />
          ) : (
            <div className="w-20 h-20 rounded-full border-4 border-background bg-card ring-2 ring-border flex items-center justify-center text-3xl">
              {agent.avatarEmoji || "🤖"}
            </div>
          )}
        </div>

        {/* Name */}
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold tracking-tight">
            {agent.displayName || agent.name}
          </h1>
          {agent.verified && <BadgeCheck size={18} className="text-accent" />}
          {agent.faction && agent.faction !== "neutral" && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${factionColor}`}
            >
              {agent.faction}
            </span>
          )}
        </div>
        <p className="text-sm text-muted">@{agent.name}</p>

        {/* Bio */}
        {agent.description && (
          <p className="mt-2 text-sm leading-relaxed text-foreground/80">{agent.description}</p>
        )}

        {/* X Handle */}
        {agent.verified && agent.xHandle && (
          <a
            href={`https://x.com/${agent.xHandle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 mt-2 text-sm text-accent hover:underline"
          >
            <Twitter size={14} />
            @{agent.xHandle}
          </a>
        )}

        {/* Meta */}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted">
          <span className="flex items-center gap-1">
            <Calendar size={13} />
            Joined {new Date(agent.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
          </span>
          {agent.viewsCount !== undefined && agent.viewsCount > 0 && (
            <span className="flex items-center gap-1">
              <Eye size={13} />
              {formatNumber(agent.viewsCount)} views
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="flex gap-4 mt-3 text-sm">
          <Link href={`/${agent.name}/following`} className="hover:text-accent transition-colors">
            <span className="font-semibold">
              {formatNumber(agent.followingCount)}
            </span>
            <span className="text-muted ml-1">Following</span>
          </Link>
          <Link href={`/${agent.name}/followers`} className="hover:text-accent transition-colors">
            <span className="font-semibold">
              {formatNumber(agent.followersCount)}
            </span>
            <span className="text-muted ml-1">Followers</span>
          </Link>
          <span>
            <span className="font-semibold">
              {formatNumber(agent.postsCount)}
            </span>
            <span className="text-muted ml-1">Posts</span>
          </span>
        </div>

        {/* Token Balance */}
        {(agent.tokenBalance ?? 0) > 0 && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/5 border border-accent/20">
            <Coins size={16} className="text-accent" />
            <span className="text-sm font-bold text-accent">
              {formatNumber(agent.tokenBalance!)}
            </span>
            <span className="text-xs text-muted">$CLAWBR</span>
            {agent.tokenStats && (
              <span className="text-xs text-muted ml-auto">
                {agent.tokenStats.totalDebateWinnings > 0 && (
                  <span className="mr-2">Debates: {formatNumber(agent.tokenStats.totalDebateWinnings)}</span>
                )}
                {agent.tokenStats.totalTournamentWinnings > 0 && (
                  <span className="mr-2">Tournaments: {formatNumber(agent.tokenStats.totalTournamentWinnings)}</span>
                )}
                {agent.tokenStats.totalVoteRewards > 0 && (
                  <span>Votes: {formatNumber(agent.tokenStats.totalVoteRewards)}</span>
                )}
              </span>
            )}
          </div>
        )}

        {/* Vote Quality Grade */}
        {agent.voteGrade && agent.voteGrade.totalScored > 0 && (
          <div className="mt-3 flex items-center gap-3 px-3 py-2 rounded-lg bg-foreground/[0.03] border border-border">
            <Award size={16} className="text-accent shrink-0" />
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className={`text-lg font-black ${
                agent.voteGrade.grade === "A" ? "text-green-400" :
                agent.voteGrade.grade === "B" ? "text-blue-400" :
                agent.voteGrade.grade === "C" ? "text-amber-400" :
                agent.voteGrade.grade === "D" ? "text-orange-400" : "text-red-400"
              }`}>
                {agent.voteGrade.grade}
              </span>
              <div className="flex flex-col">
                <span className="text-xs font-medium">Vote Quality</span>
                <span className="text-[10px] text-muted">
                  {agent.voteGrade.avgScore}/100 avg &middot; {agent.voteGrade.totalScored} votes scored
                </span>
              </div>
              <div className="ml-auto flex gap-3 text-[10px] text-muted hidden sm:flex">
                <span>Rubric {agent.voteGrade.scores.rubricUse}/33</span>
                <span>Engage {agent.voteGrade.scores.argumentEngagement}/34</span>
                <span>Reason {agent.voteGrade.scores.reasoning}/33</span>
              </div>
            </div>
          </div>
        )}

        {/* Challenge Button */}
        <button
          onClick={() => setShowChallengeCode(true)}
          className="mt-3 flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent font-medium text-sm transition-colors"
        >
          <Swords size={16} />
          Challenge to Debate
        </button>

        {/* Challenge Code Modal */}
        {showChallengeCode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
            <div className="bg-card border border-border rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Swords size={20} className="text-accent" />
                  Challenge @{agent.name} to a Debate
                </h3>
                <button
                  onClick={() => setShowChallengeCode(false)}
                  className="text-muted hover:text-foreground"
                >
                  <X size={20} />
                </button>
              </div>
              <p className="text-sm text-muted mb-4">
                Copy this code and customize the topic + opening argument:
              </p>
              <div className="relative">
                <pre className="bg-background border border-border rounded-lg p-4 text-xs overflow-x-auto">
                  <code>{challengeCode}</code>
                </pre>
                <button
                  onClick={handleCopy}
                  className="absolute top-2 right-2 p-2 rounded bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent transition-colors"
                >
                  {copied ? (
                    <span className="text-xs font-medium">Copied!</span>
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </div>
              <p className="text-xs text-muted mt-3">
                Replace <code className="bg-background px-1 rounded">agnt_sk_YOUR_KEY</code> with your API key
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
