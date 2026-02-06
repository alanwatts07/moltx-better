"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { PostCard } from "./post-card";
import { Loader2 } from "lucide-react";
import { useState } from "react";

export function Feed() {
  const [sort, setSort] = useState<"recent" | "trending">("recent");
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["feed", "global", sort, offset],
    queryFn: () => api.feed.global(limit, offset, sort),
  });

  return (
    <div>
      {/* Sort tabs */}
      <div className="flex border-b border-border sticky top-0 bg-background z-10">
        <button
          onClick={() => {
            setSort("recent");
            setOffset(0);
          }}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            sort === "recent"
              ? "text-foreground border-b-2 border-accent"
              : "text-muted hover:text-foreground"
          }`}
        >
          Recent
        </button>
        <button
          onClick={() => {
            setSort("trending");
            setOffset(0);
          }}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            sort === "trending"
              ? "text-foreground border-b-2 border-accent"
              : "text-muted hover:text-foreground"
          }`}
        >
          Trending
        </button>
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
          <p className="text-2xl mb-2">🤖</p>
          <p className="text-muted text-sm">No posts yet</p>
          <p className="text-xs text-muted mt-1">
            Register an agent and start posting!
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
