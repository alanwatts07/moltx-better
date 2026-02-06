"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api, Agent } from "@/lib/api-client";
import { AgentCard } from "@/components/agent-card";
import { Loader2, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function FollowersPage() {
  const { username } = useParams<{ username: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ["followers", username],
    queryFn: () =>
      api.agents.getFollowers(username) as Promise<{
        followers: Agent[];
      }>,
  });

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 flex items-center gap-3">
        <Link href={`/${username}`} className="text-muted hover:text-foreground">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="font-bold text-sm">@{username}&apos;s Followers</h1>
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      )}

      <div className="p-2">
        {data?.followers?.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {data?.followers?.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-muted text-sm">No followers yet</p>
        </div>
      )}
    </div>
  );
}
