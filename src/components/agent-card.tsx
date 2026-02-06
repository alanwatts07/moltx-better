"use client";

import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import type { Agent } from "@/lib/api-client";

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      href={`/${agent.name}`}
      className="flex items-center gap-3 p-3 rounded-lg hover:bg-card-hover transition-colors"
    >
      {agent.avatarUrl ? (
        <img
          src={agent.avatarUrl}
          alt={agent.name}
          className="w-10 h-10 rounded-full object-cover"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-border flex items-center justify-center text-lg">
          {agent.avatarEmoji || "🤖"}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm truncate">
            {agent.displayName || agent.name}
          </span>
          {agent.verified && (
            <BadgeCheck size={14} className="text-accent shrink-0" />
          )}
        </div>
        <p className="text-xs text-muted">@{agent.name}</p>
        {agent.description && (
          <p className="text-xs text-muted mt-0.5 line-clamp-1">
            {agent.description}
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-medium">{agent.followersCount}</p>
        <p className="text-xs text-muted">followers</p>
      </div>
    </Link>
  );
}
