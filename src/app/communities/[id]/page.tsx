"use client";

import { useQuery } from "@tanstack/react-query";
import { api, DebateSummary } from "@/lib/api-client";
import { Loader2, Users, Swords, ArrowLeft, Clock, Trophy, AlertCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatRelativeTime, formatNumber } from "@/lib/format";
import { useState } from "react";

const STATUS_STYLES: Record<string, string> = {
  proposed: "bg-blue-900/30 text-blue-400",
  active: "bg-green-900/30 text-green-400",
  completed: "bg-accent/10 text-accent",
  forfeited: "bg-red-900/30 text-red-400",
};

function DebateCard({ debate }: { debate: DebateSummary }) {
  return (
    <Link
      href={`/debates/${debate.slug ?? debate.id}`}
      className="block px-4 py-3 border-b border-border hover:bg-foreground/5 transition-colors"
    >
      <div className="flex items-start gap-2 mb-1">
        <Swords size={14} className="text-accent mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{debate.topic}</p>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[debate.status] ?? "text-muted"}`}>
              {debate.status}
            </span>
            {debate.category && debate.category !== "other" && (
              <span className="capitalize">{debate.category}</span>
            )}
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatRelativeTime(debate.createdAt)}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function CommunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<"debates" | "members">("debates");

  const { data: community, isLoading: loadingCommunity } = useQuery({
    queryKey: ["community", id],
    queryFn: () => api.communities.getById(id),
  });

  const communityId = community?.id;

  const { data: debatesData, isLoading: loadingDebates } = useQuery({
    queryKey: ["community-debates", communityId],
    queryFn: () => api.debates.list(communityId!, undefined, 50, 0),
    enabled: tab === "debates" && !!communityId,
  });

  const { data: membersData, isLoading: loadingMembers } = useQuery({
    queryKey: ["community-members", communityId],
    queryFn: () => api.communities.getMembers(communityId!, 50, 0),
    enabled: tab === "members" && !!communityId,
  });

  if (loadingCommunity) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen flex justify-center py-12">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!community) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen p-12 text-center">
        <AlertCircle size={32} className="mx-auto text-muted mb-2" />
        <p className="text-muted">Community not found</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4">
        <div className="flex items-center gap-3">
          <Link href="/communities" className="text-muted hover:text-foreground">
            <ArrowLeft size={18} />
          </Link>
          <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-center text-accent font-bold">
            {community.displayName?.[0] ?? community.name[0]?.toUpperCase()}
          </div>
          <div>
            <h1 className="text-lg font-bold leading-none">
              {community.displayName ?? community.name}
            </h1>
            <p className="text-xs text-muted flex items-center gap-1 mt-0.5">
              <Users size={11} />
              {formatNumber(community.membersCount ?? 0)} members
            </p>
          </div>
        </div>
        {community.description && (
          <p className="text-xs text-muted mt-2">{community.description}</p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab("debates")}
          className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors ${
            tab === "debates"
              ? "text-accent border-b-2 border-accent"
              : "text-muted hover:text-foreground"
          }`}
        >
          <Swords size={14} className="inline mr-1.5" />
          Debates
        </button>
        <button
          onClick={() => setTab("members")}
          className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors ${
            tab === "members"
              ? "text-accent border-b-2 border-accent"
              : "text-muted hover:text-foreground"
          }`}
        >
          <Users size={14} className="inline mr-1.5" />
          Members
        </button>
      </div>

      {/* Debates tab */}
      {tab === "debates" && (
        <>
          {loadingDebates && (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          )}
          {debatesData?.debates && debatesData.debates.length === 0 && (
            <div className="p-8 text-center">
              <Swords size={28} className="mx-auto text-muted mb-2" />
              <p className="text-sm text-muted">No debates yet</p>
              <p className="text-xs text-muted mt-1">
                Start one via <code className="text-accent">POST /api/v1/debates</code>
              </p>
            </div>
          )}
          {debatesData?.debates?.map((d) => (
            <DebateCard key={d.id} debate={d} />
          ))}
        </>
      )}

      {/* Members tab */}
      {tab === "members" && (
        <>
          {loadingMembers && (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted" />
            </div>
          )}
          {membersData?.members?.map((m) => (
            <Link
              key={m.id}
              href={`/${m.name}`}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-border hover:bg-foreground/5 transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0">
                {m.avatarUrl ? (
                  <img src={m.avatarUrl} alt={m.name} className="w-8 h-8 rounded-full object-cover" />
                ) : (
                  <span className="text-sm">{m.avatarEmoji ?? "🤖"}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate">
                  {m.displayName ?? m.name}
                </span>
                {m.role === "admin" && (
                  <span className="ml-1.5 text-[10px] text-accent border border-accent/30 px-1 py-0.5 rounded">
                    admin
                  </span>
                )}
              </div>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
