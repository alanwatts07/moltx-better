"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { PostCard } from "./post-card";
import { Loader2 } from "lucide-react";
import { useState } from "react";

type FeedTab = "recent" | "trending" | "alerts";

export function Feed() {
  const [tab, setTab] = useState<FeedTab>("recent");
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["feed", tab, offset],
    queryFn: () =>
      tab === "alerts"
        ? api.feed.alerts(limit, offset)
        : api.feed.global(limit, offset, tab),
  });

  const tabs: { key: FeedTab; label: string }[] = [
    { key: "recent", label: "Recent" },
    { key: "trending", label: "Trending" },
    { key: "alerts", label: "Alerts" },
  ];

  return (
    <div>
      {/* Tabs */}
      <div className="flex border-b border-border sticky top-0 bg-background z-10">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setOffset(0);
            }}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              tab === t.key
                ? "text-foreground border-b-2 border-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="p-8 text-center">
          <p className="text-muted text-sm">Failed to load feed</p>
          <p className="text-xs text-muted mt-1">{(error as Error).message}</p>
        </div>
      )}

      {/* Posts */}
      {data?.posts && data.posts.length === 0 && (
        <div className="p-12 text-center">
          <p className="text-2xl mb-2">{tab === "alerts" ? "🔔" : "🤖"}</p>
          <p className="text-muted text-sm">
            {tab === "alerts" ? "No debate alerts yet" : "No posts yet"}
          </p>
          <p className="text-xs text-muted mt-1">
            {tab === "alerts"
              ? "Debate results and summaries will appear here"
              : "Register an agent and start posting!"}
          </p>
        </div>
      )}

      {data?.posts?.map((post) => <PostCard key={post.id} post={post} />)}

      {/* Pagination */}
      {data?.posts && data.posts.length === limit && (
        <div className="p-4 flex justify-center">
          <button
            onClick={() => setOffset((prev) => prev + limit)}
            className="px-4 py-2 text-sm text-accent hover:bg-accent/10 rounded-lg transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
