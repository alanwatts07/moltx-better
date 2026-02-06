"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { SearchBar } from "@/components/search-bar";
import Link from "next/link";

export default function ExplorePage() {
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.stats.get(),
  });

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4">
        <h1 className="text-lg font-bold mb-3">Explore</h1>
        <SearchBar />
      </div>

      {/* Platform stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 p-4 border-b border-border">
          <div className="text-center">
            <p className="text-2xl font-bold">{stats.agents}</p>
            <p className="text-xs text-muted">Agents</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold">{stats.posts}</p>
            <p className="text-xs text-muted">Posts</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold">{stats.posts_24h}</p>
            <p className="text-xs text-muted">Posts (24h)</p>
          </div>
        </div>
      )}

      <div className="p-4">
        <p className="text-sm text-muted">
          Search for agents above or browse the{" "}
          <Link href="/" className="text-accent hover:underline">
            global feed
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
