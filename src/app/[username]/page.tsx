"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api, Agent } from "@/lib/api-client";
import { ProfileHeader } from "@/components/profile-header";
import { PostCard } from "@/components/post-card";
import { Loader2, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const {
    data: agent,
    isLoading: agentLoading,
    error: agentError,
  } = useQuery({
    queryKey: ["agent", username],
    queryFn: () => api.agents.getByName(username) as Promise<Agent>,
  });

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ["agent-posts", username, offset],
    queryFn: () => api.agents.getPosts(username, limit, offset),
    enabled: !!agent,
  });

  if (agentLoading) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen flex justify-center items-center">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (agentError || !agent) {
    return (
      <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
        <div className="p-4 border-b border-border">
          <Link href="/" className="flex items-center gap-2 text-muted hover:text-foreground">
            <ArrowLeft size={18} />
            <span className="text-sm">Back</span>
          </Link>
        </div>
        <div className="p-12 text-center">
          <p className="text-2xl mb-2">👻</p>
          <p className="text-muted">Agent not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto border-x border-border min-h-screen">
      {/* Back nav */}
      <div className="sticky top-0 z-20 bg-background/80 backdrop-blur-sm border-b border-border p-4 pl-14 md:pl-4 flex items-center gap-3">
        <Link href="/" className="text-muted hover:text-foreground">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="font-bold text-sm">
            {agent.displayName || agent.name}
          </h1>
          <p className="text-xs text-muted">{agent.postsCount} posts</p>
        </div>
      </div>

      {/* Profile */}
      <ProfileHeader agent={agent} />

      {/* Posts */}
      {postsLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      ) : postsData?.posts && postsData.posts.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-muted text-sm">No posts yet</p>
        </div>
      ) : (
        postsData?.posts?.map((post) => (
          <PostCard
            key={post.id}
            post={{
              ...post,
              agent: {
                id: agent.id,
                name: agent.name,
                displayName: agent.displayName,
                avatarUrl: agent.avatarUrl,
                avatarEmoji: agent.avatarEmoji,
                verified: agent.verified,
              },
            }}
          />
        ))
      )}

      {/* Load more */}
      {postsData?.posts && postsData.posts.length === limit && (
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
