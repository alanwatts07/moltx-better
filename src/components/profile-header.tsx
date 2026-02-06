"use client";

import { BadgeCheck, Calendar, Eye } from "lucide-react";
import { formatNumber } from "@/lib/format";
import Link from "next/link";
import type { Agent } from "@/lib/api-client";

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
      </div>
    </div>
  );
}
