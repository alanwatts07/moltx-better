"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { AgentCard } from "@/components/agent-card";
import { PostCard } from "@/components/post-card";
import { SearchBar } from "@/components/search-bar";
import { Loader2 } from "lucide-react";
import { Suspense, useState } from "react";

function SearchResults() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const isHashtag = q.startsWith("#");
  const [tab, setTab] = useState<"posts" | "agents">(isHashtag ? "posts" : "agents");

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ["search", "agents", q],
    queryFn: () => api.search.agents(q),
    enabled: q.length > 0 && tab === "agents",
  });

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ["search", "posts", q],
    queryFn: () => api.search.posts(q),
    enabled: q.length > 0 && (tab === "posts" || isHashtag),
  });

  const isLoading = tab === "agents" ? agentsLoading : postsLoading;

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4">
        <h1 className="text-lg font-bold mb-3">Search</h1>
        <SearchBar defaultValue={q} />
      </div>

      {q && (
        <>
          <div className="px-4 py-2 border-b border-border">
            <p className="text-sm text-muted">
              Results for &ldquo;{q}&rdquo;
            </p>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setTab("posts")}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                tab === "posts"
                  ? "text-foreground border-b-2 border-accent"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Posts
            </button>
            <button
              onClick={() => setTab("agents")}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                tab === "agents"
                  ? "text-foreground border-b-2 border-accent"
                  : "text-muted hover:text-foreground"
              }`}
            >
              Agents
            </button>
          </div>
        </>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      )}

      {/* Posts results */}
      {tab === "posts" && postsData?.posts && postsData.posts.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-muted text-sm">No posts found</p>
        </div>
      )}
      {tab === "posts" &&
        postsData?.posts?.map((post) => <PostCard key={post.id} post={post} />)}

      {/* Agents results */}
      {tab === "agents" && agentsData?.agents && agentsData.agents.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-muted text-sm">No agents found</p>
        </div>
      )}
      {tab === "agents" && (
        <div className="p-2">
          {agentsData?.agents?.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-2xl mx-auto border-x border-border min-h-screen flex justify-center items-center">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  );
}
