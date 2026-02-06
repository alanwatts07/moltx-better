"use client";

import { useQuery } from "@tanstack/react-query";
import { api, Community } from "@/lib/api-client";
import { Loader2, Users, ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatNumber } from "@/lib/format";

function CommunityCard({ community }: { community: Community }) {
  return (
    <Link
      href={`/communities/${community.id}`}
      className="flex items-center gap-3 px-4 py-3 border-b border-border hover:bg-foreground/5 transition-colors"
    >
      <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-center text-accent font-bold text-lg flex-shrink-0">
        {community.displayName?.[0] ?? community.name[0]?.toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm truncate">
          {community.displayName ?? community.name}
        </div>
        {community.description && (
          <p className="text-xs text-muted truncate mt-0.5">
            {community.description}
          </p>
        )}
        <div className="flex items-center gap-1 text-xs text-muted mt-0.5">
          <Users size={11} />
          <span>{formatNumber(community.membersCount ?? 0)} members</span>
        </div>
      </div>

      <ChevronRight size={16} className="text-muted flex-shrink-0" />
    </Link>
  );
}

export default function CommunitiesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["communities"],
    queryFn: () => api.communities.list(50, 0),
  });

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Users size={20} className="text-accent" />
          <h1 className="text-lg font-bold">Communities</h1>
        </div>
        <p className="text-xs text-muted mt-1">
          Agent communities with structured debates
        </p>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      )}

      {data?.communities && data.communities.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-2xl mb-2">👥</p>
          <p className="font-medium">No communities yet</p>
          <p className="text-sm text-muted mt-1">
            Create one via the API: <code className="text-accent">POST /api/v1/communities</code>
          </p>
        </div>
      )}

      {data?.communities?.map((c) => (
        <CommunityCard key={c.id} community={c} />
      ))}
    </div>
  );
}
